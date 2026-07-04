import { structuredCall, type AnthropicLike } from '../clients/claude';
import type { ClaudeEffort } from '../constants';
import type { Store } from '../store/store';
import { storyBibleTemplate } from '../templates';
import type { CanonRegistry, SettingMode, Story, StoryMeta } from '../types';
import { DEFAULT_DISSECT_MODEL, extractCanon } from './canon';

/**
 * LLM-assisted bootstrapping: turn a one-line idea into a fully-populated
 * story (title, production metadata, template-conformant bible) or a drafted
 * episode (title, brief, optional setting). Story bootstrap creates the story
 * directly; episode drafting only proposes values so a human reviews them in
 * the form before saving — the AI is crew, not director.
 */

const STORY_SYSTEM = `You are the head of story development at an AI video production studio.
From a single idea, develop a complete series concept ready for production of short-form videos.

Produce:
- "title": a memorable series title (not a sentence).
- "setting_mode": "shared" when episodes share one world/setting; "per-episode" when the premise implies a new setting each episode (e.g. travel/anthology formats).
- "continuity": "random" for episodic series (standalone episodes, can run forever); "linear" when the idea implies a serialized arc with an ending (a quest, a season-long mystery, "until they finally...").
- "meta": production metadata inferred from the idea. Infer a sensible target audience age range; genres (2-4, lowercase); tones (3-5 adjectives); a format line (e.g. "3D animated comedy shorts"); episode_length_sec (default 60 for Shorts); language.
- "bible_markdown": a COMPLETE story bible in Markdown following EXACTLY the section structure of the reference template provided by the user — same numbered headings. Replace every placeholder with concrete, production-ready content:
  * 2-5 main characters. Describe EVERY character to the SAME level of detail using the same fields in the same order, so none renders "a little off": species/build, exact primary & secondary colors and materials, face/head shape, eyes, 1-3 signature never-change features, outfit (or "none"), and proportions/scale. Then personality with one comic/dramatic flaw, movement style, voice, catchphrases, and an explicit "Never change" list. A stranger must be able to paint each character from its description ALONE.
  * A concrete world with explicit world rules (what is possible/impossible), a color palette to use and moods to avoid, and default lighting.
  * A "Reference background" line in the visual style section: ONE fixed neutral backdrop used for all character reference images (e.g. "seamless soft-gradient studio backdrop, warm neutral grey, even soft key light") so every reference image looks like part of the same set.
  * Relationships between character pairs, 2-4 recurring locations with fixed landmarks and "never change" facts, a repeatable story formula with beats, visual & camera style, and a Do/Don't safety-rails section calibrated to the audience age.
  * Section 10 consistency prompts: one ready-to-paste paragraph per character and location, each self-contained and restating the full visual signature.
If the audience is children (12 or under), the entire bible must be emotionally safe: no violence, weapons, fear, bullying, or sarcasm; accidents harmless with soft landings; stories understandable with the sound off.
Write concretely and uniformly — a stranger (or a video model) must be able to paint every character from the bible alone.`;

function storyBootstrapSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string' },
      setting_mode: { type: 'string', enum: ['shared', 'per-episode'] },
      continuity: { type: 'string', enum: ['random', 'linear'] },
      meta: {
        type: 'object',
        additionalProperties: false,
        properties: {
          audience_min: { type: 'integer' },
          audience_max: { type: 'integer' },
          audience_notes: { type: 'string' },
          genres: { type: 'array', items: { type: 'string' } },
          tones: { type: 'array', items: { type: 'string' } },
          format: { type: 'string' },
          episode_length_sec: { type: 'integer' },
          language: { type: 'string' },
        },
        required: [
          'audience_min',
          'audience_max',
          'audience_notes',
          'genres',
          'tones',
          'format',
          'episode_length_sec',
          'language',
        ],
      },
      bible_markdown: { type: 'string' },
    },
    required: ['title', 'setting_mode', 'continuity', 'meta', 'bible_markdown'],
  };
}

interface RawStoryBootstrap {
  title: string;
  setting_mode: SettingMode;
  continuity?: 'random' | 'linear';
  meta: {
    audience_min: number;
    audience_max: number;
    audience_notes: string;
    genres: string[];
    tones: string[];
    format: string;
    episode_length_sec: number;
    language: string;
  };
  bible_markdown: string;
}

export interface BootstrapStoryOptions {
  idea: string;
  model?: string;
  effort?: ClaudeEffort;
  /** Also dissect the generated bible into canon v1 (same model). */
  withCanon?: boolean;
}

export interface BootstrapStoryResult {
  story: Story;
  registry: CanonRegistry | null;
}

export async function bootstrapStory(
  store: Store,
  claude: AnthropicLike,
  options: BootstrapStoryOptions,
): Promise<BootstrapStoryResult> {
  const idea = options.idea?.trim();
  if (!idea) throw new Error('An idea is required to bootstrap a story.');

  const user = [
    '# Idea',
    idea,
    '',
    '# Reference template (follow this exact section structure in bible_markdown)',
    storyBibleTemplate('<Series Title>'),
  ].join('\n');

  const { json } = await structuredCall(claude, {
    model: options.model ?? DEFAULT_DISSECT_MODEL,
    effort: options.effort ?? 'high',
    system: STORY_SYSTEM,
    user,
    schema: storyBootstrapSchema(),
    maxTokens: 32000,
  });
  const raw = json as RawStoryBootstrap;

  const meta: Partial<StoryMeta> = {
    audienceMin: Number.isFinite(raw.meta?.audience_min) ? raw.meta.audience_min : null,
    audienceMax: Number.isFinite(raw.meta?.audience_max) ? raw.meta.audience_max : null,
    audienceNotes: raw.meta?.audience_notes ?? '',
    genres: (raw.meta?.genres ?? []).map((g) => g.trim()).filter(Boolean),
    tones: (raw.meta?.tones ?? []).map((t) => t.trim()).filter(Boolean),
    format: raw.meta?.format ?? '',
    episodeLengthSec: Number.isFinite(raw.meta?.episode_length_sec) ? raw.meta.episode_length_sec : 60,
    language: raw.meta?.language || 'English',
  };

  const story = store.createStory({
    title: raw.title?.trim() || idea.slice(0, 60),
    settingMode: raw.setting_mode === 'per-episode' ? 'per-episode' : 'shared',
    continuity: raw.continuity === 'linear' ? 'linear' : 'random',
    bible: raw.bible_markdown ?? '',
    meta,
  });

  let registry: CanonRegistry | null = null;
  if (options.withCanon) {
    registry = await extractCanon(store, claude, story.id, {
      model: options.model ?? DEFAULT_DISSECT_MODEL,
      note: 'Initial extraction from bootstrapped bible',
    });
  }
  return { story, registry };
}

// ---------------------------------------------------------------------------
// Episode drafting (proposes values; nothing is persisted)
// ---------------------------------------------------------------------------

const EPISODE_SYSTEM = `You are an episode developer at an AI video production studio.
From an episode idea plus the series bible, draft one episode of the series.

Produce:
- "title": a short, catchy episode title.
- "brief": 2-4 sentences describing what happens — goal, obstacle, resolution — consistent with the bible's characters, world rules, tone, and audience.
- "setting_markdown": ONLY when the user says the series uses per-episode settings AND the idea implies a distinct setting: a short episode-setting document (setting, one-off characters/props with visual signatures, mood, what must stay consistent). Otherwise return an empty string.
Stay strictly inside the series' canon and safety rails.`;

function episodeDraftSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string' },
      brief: { type: 'string' },
      setting_markdown: { type: 'string' },
    },
    required: ['title', 'brief', 'setting_markdown'],
  };
}

export interface EpisodeDraft {
  title: string;
  brief: string;
  setting: string;
}

export async function draftEpisode(
  store: Store,
  claude: AnthropicLike,
  storyId: string,
  idea: string,
  options: { model?: string; effort?: ClaudeEffort } = {},
): Promise<EpisodeDraft> {
  const trimmed = idea?.trim();
  if (!trimmed) throw new Error('An idea is required to draft an episode.');
  const story = store.getStory(storyId);
  const bible = store.getBible(storyId);

  const user = [
    '# Episode idea',
    trimmed,
    '',
    `# Series setting mode: ${story.settingMode}`,
    story.meta.audienceMax != null ? `# Audience: ages ${story.meta.audienceMin ?? '?'}–${story.meta.audienceMax}` : '',
    '',
    '# Series bible',
    bible,
  ]
    .filter(Boolean)
    .join('\n');

  const { json } = await structuredCall(claude, {
    model: options.model ?? DEFAULT_DISSECT_MODEL,
    effort: options.effort ?? 'medium',
    system: EPISODE_SYSTEM,
    user,
    schema: episodeDraftSchema(),
  });
  const raw = json as { title: string; brief: string; setting_markdown: string };
  return {
    title: raw.title?.trim() ?? '',
    brief: raw.brief?.trim() ?? '',
    setting: story.settingMode === 'per-episode' ? (raw.setting_markdown ?? '').trim() : '',
  };
}
