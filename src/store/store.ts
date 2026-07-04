import fs from 'node:fs';
import path from 'node:path';
import { storyBibleTemplate } from '../templates';
import {
  defaultStoryMeta,
  type CanonRegistry,
  type CharacterRegistry,
  type Episode,
  type Project,
  type Story,
  type StoryMeta,
} from '../types';

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
      const db = { ...emptyDb(), ...parsed } as Db;
      // Backfill fields for records created before they existed.
      for (const story of Object.values(db.stories)) {
        if (!story.meta) story.meta = defaultStoryMeta();
        if (!story.continuity) story.continuity = 'random';
        if (story.plan === undefined) story.plan = null;
      }
      for (const episode of Object.values(db.episodes)) {
        if (episode.runtimeSec === undefined) episode.runtimeSec = null;
        if (episode.plannedNumber === undefined) episode.plannedNumber = null;
      }
      for (const project of Object.values(db.projects)) {
        if (project.publishHistory === undefined) {
          // Seed history from the single legacy publish record, if any.
          project.publishHistory = project.publish ? [project.publish] : [];
        }
      }
      return db;
    } catch {
      return emptyDb();
    }
  }

  private persist(): void {
    fs.mkdirSync(this.baseDir, { recursive: true });
    fs.writeFileSync(this.dbPath, JSON.stringify(this.db, null, 2), 'utf8');
  }

  // ---- Stories ----

  createStory(input: {
    title: string;
    settingMode?: Story['settingMode'];
    continuity?: Story['continuity'];
    bible?: string;
    meta?: Partial<StoryMeta>;
  }): Story {
    const now = new Date().toISOString();
    const id = makeId('story');
    const story: Story = {
      id,
      title: input.title.trim() || 'Untitled story',
      slug: slugify(input.title),
      settingMode: input.settingMode ?? 'shared',
      continuity: input.continuity ?? 'random',
      plan: null,
      meta: { ...defaultStoryMeta(), ...input.meta },
      createdAt: now,
      updatedAt: now,
    };
    fs.mkdirSync(this.storyDir(id), { recursive: true });
    fs.writeFileSync(this.biblePath(id), input.bible ?? storyBibleTemplate(story.title, story.meta), 'utf8');
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

  updateStory(
    id: string,
    patch: Partial<Pick<Story, 'title' | 'settingMode' | 'continuity'>> & { meta?: Partial<StoryMeta> },
  ): Story {
    const s = this.getStory(id);
    if (patch.title !== undefined) {
      s.title = patch.title.trim() || s.title;
      s.slug = slugify(s.title);
    }
    if (patch.settingMode !== undefined) s.settingMode = patch.settingMode;
    if (patch.continuity !== undefined) s.continuity = patch.continuity;
    if (patch.meta !== undefined) s.meta = { ...s.meta, ...patch.meta };
    s.updatedAt = new Date().toISOString();
    this.persist();
    return s;
  }

  setStoryPlan(id: string, plan: Story['plan']): Story {
    const s = this.getStory(id);
    s.plan = plan;
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

  createEpisode(
    storyId: string,
    input: { title: string; brief?: string; setting?: string; runtimeSec?: number | null; plannedNumber?: number | null },
  ): Episode {
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
      runtimeSec: input.runtimeSec ?? null,
      plannedNumber: input.plannedNumber ?? null,
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

  updateEpisode(id: string, patch: Partial<Pick<Episode, 'title' | 'brief' | 'runtimeSec'>>): Episode {
    const e = this.getEpisode(id);
    if (patch.title !== undefined) e.title = patch.title.trim() || e.title;
    if (patch.brief !== undefined) e.brief = patch.brief;
    if (patch.runtimeSec !== undefined) e.runtimeSec = patch.runtimeSec;
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

  // ---- Canon registry (version-controlled consistency marks) ----

  private canonPath(storyId: string): string {
    return path.join(this.storyDir(storyId), 'canon.json');
  }

  getCanonRegistry(storyId: string): CanonRegistry | null {
    this.getStory(storyId);
    try {
      return JSON.parse(fs.readFileSync(this.canonPath(storyId), 'utf8')) as CanonRegistry;
    } catch {
      return null;
    }
  }

  saveCanonRegistry(registry: CanonRegistry): CanonRegistry {
    const s = this.getStory(registry.storyId);
    fs.mkdirSync(this.storyDir(registry.storyId), { recursive: true });
    fs.writeFileSync(this.canonPath(registry.storyId), JSON.stringify(registry, null, 2), 'utf8');
    s.updatedAt = new Date().toISOString();
    this.persist();
    return registry;
  }

  // ---- Character reference images (versioned portraits) ----

  private charactersPath(storyId: string): string {
    return path.join(this.storyDir(storyId), 'characters.json');
  }

  getCharacterRegistry(storyId: string): CharacterRegistry | null {
    this.getStory(storyId);
    try {
      const registry = JSON.parse(fs.readFileSync(this.charactersPath(storyId), 'utf8')) as CharacterRegistry;
      // Backfill fields for assets/versions persisted before they existed.
      for (const asset of Object.values(registry.characters)) {
        if (!asset.type) asset.type = 'character';
        for (const version of asset.versions) {
          if (version.imageError === undefined) version.imageError = null;
          if (version.sourceImageUrl === undefined) version.sourceImageUrl = null;
        }
      }
      return registry;
    } catch {
      return null;
    }
  }

  saveCharacterRegistry(registry: CharacterRegistry): CharacterRegistry {
    const s = this.getStory(registry.storyId);
    fs.mkdirSync(this.storyDir(registry.storyId), { recursive: true });
    fs.writeFileSync(this.charactersPath(registry.storyId), JSON.stringify(registry, null, 2), 'utf8');
    s.updatedAt = new Date().toISOString();
    this.persist();
    return registry;
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

  /** Every project (storyline) in the studio — used by background job recovery. */
  listProjects(): Project[] {
    return Object.values(this.db.projects);
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

  // ---- Snapshot / restore (fail-safe for cascading deletes) ----

  /** A lossless snapshot of an episode and everything under it. */
  snapshotEpisode(episodeId: string): EpisodeSnapshot {
    const episode = this.getEpisode(episodeId);
    return {
      episode: structuredClone(episode),
      setting: this.getSetting(episodeId),
      projects: this.listProjectsByEpisode(episodeId).map((p) => structuredClone(p)),
    };
  }

  /** A lossless snapshot of a story and its whole subtree (bible, canon, characters, episodes, storylines). */
  snapshotStory(storyId: string): StorySnapshot {
    const story = this.getStory(storyId);
    return {
      story: structuredClone(story),
      bible: this.getBible(storyId),
      canon: this.getCanonRegistry(storyId),
      characters: this.getCharacterRegistry(storyId),
      episodes: this.listEpisodes(storyId).map((e) => this.snapshotEpisode(e.id)),
    };
  }

  hasStory(id: string): boolean {
    return Boolean(this.db.stories[id]);
  }
  hasEpisode(id: string): boolean {
    return Boolean(this.db.episodes[id]);
  }

  /** Restore an episode subtree from a snapshot. Parent story must already exist. */
  restoreEpisodeSnapshot(snap: EpisodeSnapshot, opts: { skipStoryCheck?: boolean } = {}): Episode {
    const ep = snap.episode;
    if (this.db.episodes[ep.id]) throw new NotFoundError(`Episode already exists: ${ep.id}`);
    if (!opts.skipStoryCheck) this.getStory(ep.storyId);
    this.db.episodes[ep.id] = structuredClone(ep);
    if (snap.setting && snap.setting.trim()) {
      const p = this.settingPath(ep.id, ep.storyId);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, snap.setting, 'utf8');
    }
    for (const project of snap.projects) this.db.projects[project.storyline.id] = structuredClone(project);
    this.persist();
    return this.db.episodes[ep.id];
  }

  /** Restore a whole story subtree from a snapshot. */
  restoreStorySnapshot(snap: StorySnapshot): Story {
    const id = snap.story.id;
    if (this.db.stories[id]) throw new NotFoundError(`Story already exists: ${id}`);
    fs.mkdirSync(this.storyDir(id), { recursive: true });
    this.db.stories[id] = structuredClone(snap.story);
    fs.writeFileSync(this.biblePath(id), snap.bible ?? '', 'utf8');
    if (snap.canon) fs.writeFileSync(this.canonPath(id), JSON.stringify(snap.canon, null, 2), 'utf8');
    if (snap.characters) fs.writeFileSync(this.charactersPath(id), JSON.stringify(snap.characters, null, 2), 'utf8');
    for (const epSnap of snap.episodes) this.restoreEpisodeSnapshot(epSnap, { skipStoryCheck: true });
    this.persist();
    return this.db.stories[id];
  }
}

export interface EpisodeSnapshot {
  episode: Episode;
  setting: string;
  projects: Project[];
}
export interface StorySnapshot {
  story: Story;
  bible: string;
  canon: CanonRegistry | null;
  characters: CharacterRegistry | null;
  episodes: EpisodeSnapshot[];
}

export { makeId };
