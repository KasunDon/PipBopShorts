import type { Store } from '../store/store';
import { makeId } from '../store/store';
import { idleClip } from './storyline';
import type {
  CanonRegistry,
  Clip,
  Episode,
  Project,
  Scene,
  Story,
  StoryMeta,
  Storyline,
  YoutubeMeta,
} from '../types';

/**
 * Portable story package: one human-readable `.story.md` file that bundles an
 * entire IP — story metadata, the bible, every episode (brief + setting
 * override), the full canon registry (all versions), and storylines.
 *
 * Layout: normal Markdown for humans, with machine-readable sections delimited
 * by HTML-comment markers. Free-form markdown (bible, settings) sits raw
 * between markers; structured records sit in fenced JSON blocks. Runtime state
 * (rendered clips, publish records, drift reports) is intentionally excluded —
 * the package carries the creative IP, not account-bound render artifacts.
 */

export const EXPORT_FORMAT_VERSION = 1;
const HEADER = `<!-- pipbopshorts-story-export v${EXPORT_FORMAT_VERSION} -->`;

type BlockKind = 'story' | 'bible' | 'episode' | 'episode-setting' | 'storyline' | 'canon';
const BLOCK_KINDS: BlockKind[] = ['story', 'bible', 'episode', 'episode-setting', 'storyline', 'canon'];

const START = (kind: BlockKind) => `<!-- pipbop:${kind} -->`;
const END = '<!-- pipbop:end -->';

/** Guard: neutralize marker-lookalikes inside user markdown (reversed on import). */
function escapeContent(md: string): string {
  return md.replace(/<!--\s*pipbop:/g, '<!-- pipbop\\:');
}
function unescapeContent(md: string): string {
  return md.replace(/<!--\s*pipbop\\:/g, '<!-- pipbop:');
}

function jsonBlock(value: unknown): string {
  return '```json\n' + JSON.stringify(value, null, 2) + '\n```';
}

interface ExportedStoryRecord {
  formatVersion: number;
  exportedAt: string;
  title: string;
  slug: string;
  settingMode: Story['settingMode'];
  meta: StoryMeta;
}

interface ExportedEpisodeRecord {
  title: string;
  brief: string;
  hasSettingOverride: boolean;
}

interface ExportedStorylineRecord {
  title: string;
  logline: string;
  model: string;
  effort: Storyline['effort'];
  canonVersion: number | null;
  scenes: Scene[];
  youtube: YoutubeMeta;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function exportFilename(story: Story): string {
  return `${story.slug || 'story'}.story.md`;
}

export function exportStory(store: Store, storyId: string): string {
  const story = store.getStory(storyId);
  const bible = store.getBible(storyId);
  const episodes = store.listEpisodes(storyId);
  const canon = store.getCanonRegistry(storyId);

  const out: string[] = [];
  out.push(HEADER);
  out.push(`# ${story.title} — Story Package`);
  out.push('');
  out.push(
    '> Portable export from PipBopShorts. Import it on any instance via **Import story**. ' +
      'Markdown sections are editable by hand; JSON blocks are machine-read on import.',
  );
  out.push('');
  out.push('## Story');
  out.push(START('story'));
  out.push(
    jsonBlock({
      formatVersion: EXPORT_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      title: story.title,
      slug: story.slug,
      settingMode: story.settingMode,
      meta: story.meta,
    } satisfies ExportedStoryRecord),
  );
  out.push(END);
  out.push('');
  out.push('## Story Bible');
  out.push(START('bible'));
  out.push(escapeContent(bible));
  out.push(END);

  for (const episode of episodes) {
    out.push('');
    out.push(`## Episode: ${episode.title}`);
    out.push(START('episode'));
    out.push(
      jsonBlock({
        title: episode.title,
        brief: episode.brief,
        hasSettingOverride: episode.hasSettingOverride,
      } satisfies ExportedEpisodeRecord),
    );
    out.push(END);

    const setting = store.getSetting(episode.id);
    if (setting.trim()) {
      out.push('');
      out.push('### Episode Setting');
      out.push(START('episode-setting'));
      out.push(escapeContent(setting));
      out.push(END);
    }

    for (const project of store.listProjectsByEpisode(episode.id)) {
      const sl = project.storyline;
      out.push('');
      out.push(`### Storyline: ${sl.title}`);
      out.push(START('storyline'));
      out.push(
        jsonBlock({
          title: sl.title,
          logline: sl.logline,
          model: sl.model,
          effort: sl.effort,
          canonVersion: sl.canonVersion ?? null,
          scenes: sl.scenes,
          youtube: sl.youtube,
        } satisfies ExportedStorylineRecord),
      );
      out.push(END);
    }
  }

  if (canon) {
    out.push('');
    out.push('## Canon Registry (all versions)');
    out.push(START('canon'));
    out.push(jsonBlock(canon));
    out.push(END);
  }

  out.push('');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

interface ParsedBlock {
  kind: BlockKind;
  content: string;
}

/** Split the document into ordered marker-delimited blocks. */
export function parseBlocks(markdown: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const pattern = /<!--\s*pipbop:([a-z-]+)\s*-->([\s\S]*?)<!--\s*pipbop:end\s*-->/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    const kind = match[1] as BlockKind;
    if (!BLOCK_KINDS.includes(kind)) {
      throw new ImportError(`Unknown section "pipbop:${kind}" in import file.`);
    }
    blocks.push({ kind, content: match[2].trim() });
  }
  return blocks;
}

/** Parse a fenced JSON block's payload (located by markers, fences stripped). */
function parseJsonContent<T>(content: string, what: string): T {
  const lines = content.split('\n');
  if (lines[0]?.trim().startsWith('```')) lines.shift();
  if (lines[lines.length - 1]?.trim() === '```') lines.pop();
  try {
    return JSON.parse(lines.join('\n')) as T;
  } catch (err) {
    throw new ImportError(`Could not parse ${what}: ${(err as Error).message}`);
  }
}

export interface ImportResult {
  story: Story;
  episodes: Episode[];
  storylineCount: number;
  canonVersions: number;
}

/**
 * Import a `.story.md` package as a brand-new story (fresh ids, no overwrite).
 */
export function importStory(store: Store, markdown: string): ImportResult {
  if (!markdown.includes('pipbopshorts-story-export')) {
    throw new ImportError('Not a PipBopShorts story package (missing export header).');
  }
  const blocks = parseBlocks(markdown);
  const storyBlock = blocks.find((b) => b.kind === 'story');
  if (!storyBlock) throw new ImportError('Import file has no story section.');

  const record = parseJsonContent<ExportedStoryRecord>(storyBlock.content, 'story record');
  if (record.formatVersion > EXPORT_FORMAT_VERSION) {
    throw new ImportError(
      `Package format v${record.formatVersion} is newer than this platform supports (v${EXPORT_FORMAT_VERSION}).`,
    );
  }

  const bibleBlock = blocks.find((b) => b.kind === 'bible');
  const story = store.createStory({
    title: record.title,
    settingMode: record.settingMode,
    bible: bibleBlock ? unescapeContent(bibleBlock.content) : undefined,
    meta: record.meta,
  });

  const episodes: Episode[] = [];
  let storylineCount = 0;
  let currentEpisode: Episode | null = null;

  for (const block of blocks) {
    if (block.kind === 'episode') {
      const ep = parseJsonContent<ExportedEpisodeRecord>(block.content, 'episode record');
      currentEpisode = store.createEpisode(story.id, { title: ep.title, brief: ep.brief });
      episodes.push(currentEpisode);
    } else if (block.kind === 'episode-setting') {
      if (!currentEpisode) throw new ImportError('Episode setting found before any episode.');
      store.setSetting(currentEpisode.id, unescapeContent(block.content));
    } else if (block.kind === 'storyline') {
      if (!currentEpisode) throw new ImportError('Storyline found before any episode.');
      const sl = parseJsonContent<ExportedStorylineRecord>(block.content, 'storyline record');
      const now = new Date().toISOString();
      const storyline: Storyline = {
        id: makeId('sl'),
        storyId: story.id,
        episodeId: currentEpisode.id,
        title: sl.title,
        logline: sl.logline,
        model: sl.model,
        effort: sl.effort,
        canonVersion: sl.canonVersion,
        scenes: sl.scenes,
        youtube: sl.youtube,
        createdAt: now,
        updatedAt: now,
      };
      const clips: Record<string, Clip> = {};
      for (const scene of storyline.scenes) clips[scene.id] = idleClip(scene.id);
      const project: Project = { storyline, clips, publish: null };
      store.saveProject(project);
      storylineCount += 1;
    }
  }

  let canonVersions = 0;
  const canonBlock = blocks.find((b) => b.kind === 'canon');
  if (canonBlock) {
    const canon = parseJsonContent<CanonRegistry>(canonBlock.content, 'canon registry');
    canon.storyId = story.id;
    store.saveCanonRegistry(canon);
    canonVersions = canon.versions.length;
  }

  return { story: store.getStory(story.id), episodes, storylineCount, canonVersions };
}
