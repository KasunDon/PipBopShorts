import fs from 'node:fs';
import path from 'node:path';
import type { Episode, Project, Story } from '../types';

interface Db {
  stories: Record<string, Story>;
  episodes: Record<string, Episode>;
  projects: Record<string, Project>;
}

function emptyDb(): Db {
  return { stories: {}, episodes: {}, projects: {} };
}

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'story'
  );
}

let idCounter = 0;
function makeId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/**
 * File-backed persistence. Structured records live in db.json; each story's
 * bible and each per-episode setting live in their own .md files on disk so
 * users can edit them directly.
 */
export class Store {
  private db: Db;

  constructor(private readonly baseDir: string) {
    fs.mkdirSync(this.storiesDir, { recursive: true });
    this.db = this.load();
  }

  private get dbPath(): string {
    return path.join(this.baseDir, 'db.json');
  }
  private get storiesDir(): string {
    return path.join(this.baseDir, 'stories');
  }
  private storyDir(storyId: string): string {
    return path.join(this.storiesDir, storyId);
  }
  private biblePath(storyId: string): string {
    return path.join(this.storyDir(storyId), 'bible.md');
  }
  private settingPath(episodeId: string, storyId: string): string {
    return path.join(this.storyDir(storyId), 'episodes', episodeId, 'setting.md');
  }

  private load(): Db {
    try {
      const raw = fs.readFileSync(this.dbPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<Db>;
      return { ...emptyDb(), ...parsed } as Db;
    } catch {
      return emptyDb();
    }
  }

  private persist(): void {
    fs.mkdirSync(this.baseDir, { recursive: true });
    fs.writeFileSync(this.dbPath, JSON.stringify(this.db, null, 2), 'utf8');
  }

  // ---- Stories ----

  createStory(input: { title: string; settingMode?: Story['settingMode']; bible?: string }): Story {
    const now = new Date().toISOString();
    const id = makeId('story');
    const story: Story = {
      id,
      title: input.title.trim() || 'Untitled story',
      slug: slugify(input.title),
      settingMode: input.settingMode ?? 'shared',
      createdAt: now,
      updatedAt: now,
    };
    fs.mkdirSync(this.storyDir(id), { recursive: true });
    fs.writeFileSync(this.biblePath(id), input.bible ?? defaultBible(story.title), 'utf8');
    this.db.stories[id] = story;
    this.persist();
    return story;
  }

  listStories(): Story[] {
    return Object.values(this.db.stories).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getStory(id: string): Story {
    const s = this.db.stories[id];
    if (!s) throw new NotFoundError(`Story not found: ${id}`);
    return s;
  }

  updateStory(id: string, patch: Partial<Pick<Story, 'title' | 'settingMode'>>): Story {
    const s = this.getStory(id);
    if (patch.title !== undefined) {
      s.title = patch.title.trim() || s.title;
      s.slug = slugify(s.title);
    }
    if (patch.settingMode !== undefined) s.settingMode = patch.settingMode;
    s.updatedAt = new Date().toISOString();
    this.persist();
    return s;
  }

  deleteStory(id: string): void {
    this.getStory(id);
    for (const ep of this.listEpisodes(id)) this.deleteEpisode(ep.id);
    delete this.db.stories[id];
    fs.rmSync(this.storyDir(id), { recursive: true, force: true });
    this.persist();
  }

  getBible(storyId: string): string {
    this.getStory(storyId);
    try {
      return fs.readFileSync(this.biblePath(storyId), 'utf8');
    } catch {
      return '';
    }
  }

  setBible(storyId: string, markdown: string): void {
    const s = this.getStory(storyId);
    fs.mkdirSync(this.storyDir(storyId), { recursive: true });
    fs.writeFileSync(this.biblePath(storyId), markdown, 'utf8');
    s.updatedAt = new Date().toISOString();
    this.persist();
  }

  // ---- Episodes ----

  createEpisode(storyId: string, input: { title: string; brief?: string; setting?: string }): Episode {
    this.getStory(storyId);
    const now = new Date().toISOString();
    const id = makeId('ep');
    const hasSettingOverride = typeof input.setting === 'string' && input.setting.trim().length > 0;
    const episode: Episode = {
      id,
      storyId,
      title: input.title.trim() || 'Untitled episode',
      brief: input.brief ?? '',
      hasSettingOverride,
      createdAt: now,
      updatedAt: now,
    };
    if (hasSettingOverride) {
      const p = this.settingPath(id, storyId);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, input.setting as string, 'utf8');
    }
    this.db.episodes[id] = episode;
    this.persist();
    return episode;
  }

  listEpisodes(storyId: string): Episode[] {
    return Object.values(this.db.episodes)
      .filter((e) => e.storyId === storyId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getEpisode(id: string): Episode {
    const e = this.db.episodes[id];
    if (!e) throw new NotFoundError(`Episode not found: ${id}`);
    return e;
  }

  updateEpisode(id: string, patch: Partial<Pick<Episode, 'title' | 'brief'>>): Episode {
    const e = this.getEpisode(id);
    if (patch.title !== undefined) e.title = patch.title.trim() || e.title;
    if (patch.brief !== undefined) e.brief = patch.brief;
    e.updatedAt = new Date().toISOString();
    this.persist();
    return e;
  }

  deleteEpisode(id: string): void {
    const e = this.getEpisode(id);
    for (const project of this.listProjectsByEpisode(id)) {
      delete this.db.projects[project.storyline.id];
    }
    fs.rmSync(path.dirname(this.settingPath(id, e.storyId)), { recursive: true, force: true });
    delete this.db.episodes[id];
    this.persist();
  }

  getSetting(episodeId: string): string {
    const e = this.getEpisode(episodeId);
    try {
      return fs.readFileSync(this.settingPath(episodeId, e.storyId), 'utf8');
    } catch {
      return '';
    }
  }

  setSetting(episodeId: string, markdown: string): void {
    const e = this.getEpisode(episodeId);
    const p = this.settingPath(episodeId, e.storyId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, markdown, 'utf8');
    e.hasSettingOverride = markdown.trim().length > 0;
    e.updatedAt = new Date().toISOString();
    this.persist();
  }

  // ---- Projects (storyline + clips + publish) ----

  saveProject(project: Project): Project {
    this.db.projects[project.storyline.id] = project;
    this.persist();
    return project;
  }

  getProject(storylineId: string): Project {
    const p = this.db.projects[storylineId];
    if (!p) throw new NotFoundError(`Project not found: ${storylineId}`);
    return p;
  }

  listProjectsByEpisode(episodeId: string): Project[] {
    return Object.values(this.db.projects)
      .filter((p) => p.storyline.episodeId === episodeId)
      .sort((a, b) => b.storyline.createdAt.localeCompare(a.storyline.createdAt));
  }

  deleteProject(storylineId: string): void {
    this.getProject(storylineId);
    delete this.db.projects[storylineId];
    this.persist();
  }
}

function defaultBible(title: string): string {
  return `# ${title}

## Setting
Describe the world, tone, and visual style here.

## Main characters
- **Name** — appearance, personality, wardrobe, distinguishing features.

## Visual style
Color palette, lighting, mood, references.
`;
}

export { makeId };
