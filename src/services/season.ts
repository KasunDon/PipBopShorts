import { structuredCall, type AnthropicLike } from '../clients/claude';
import { UserInputError } from '../errors';
import { EPISODE_RUNTIMES, formatRuntime, type ClaudeEffort } from '../constants';
import type { Store } from '../store/store';
import type { Episode, PlannedEpisode, Story, StoryPlan } from '../types';
import { DEFAULT_DISSECT_MODEL, canonForStory } from './canon';

/**
 * Season planning & continuity-aware episode generation.
 *
 * Two continuity modes:
 * - random: standalone episodes that reuse the canon; generation avoids
 *   repeating existing episodes and can run forever.
 * - linear: a planned season arc. Episodes are generated in order from the
 *   plan, each briefed with a recap of what came before and where the arc is
 *   heading. The plan can be extended when the series should continue.
 */

export function assertRuntime(runtimeSec: number | null | undefined): void {
  if (runtimeSec == null) return;
  if (!(EPISODE_RUNTIMES as readonly number[]).includes(runtimeSec)) {
    throw new UserInputError(`runtimeSec must be one of ${EPISODE_RUNTIMES.join(', ')} seconds.`);
  }
}

function audienceGuard(story: Story): string {
  if (story.meta.audienceMax != null && story.meta.audienceMax <= 12) {
    return '\nThe audience is children: everything must be emotionally safe — no violence, fear, bullying, sarcasm, or peril; accidents are harmless with soft landings.';
  }
  return '';
}

// ---------------------------------------------------------------------------
// Season planning (linear stories)
// ---------------------------------------------------------------------------

const PLAN_SYSTEM = `You are a season architect for a serialized video series.
Design a season arc across a fixed number of episodes, from setup to a satisfying finale.

Rules:
- Every episode advances the overall arc while still telling one complete, enjoyable mini-story.
- "arc_summary" describes the season's throughline in a few sentences.
- "finale" describes how the season ends.
- Each planned episode has: a short "title", a 2-4 sentence "synopsis" (goal, obstacle, resolution), and an "arc_note" saying exactly what it contributes to the season arc (what changes, what is revealed, what carries into the next episode).
- Stay strictly inside the series bible, canon, tone, and audience.
- Escalate gently and keep continuity airtight: later episodes must build on earlier ones.`;

function planSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      arc_summary: { type: 'string' },
      finale: { type: 'string' },
      episodes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string' },
            synopsis: { type: 'string' },
            arc_note: { type: 'string' },
          },
          required: ['title', 'synopsis', 'arc_note'],
        },
      },
    },
    required: ['arc_summary', 'finale', 'episodes'],
  };
}

interface RawPlan {
  arc_summary: string;
  finale: string;
  episodes: Array<{ title: string; synopsis: string; arc_note: string }>;
}

function storyContext(store: Store, story: Story): string {
  const canon = canonForStory(store, story);
  const parts = [
    '# Series bible',
    store.getBible(story.id),
  ];
  if (canon) {
    parts.push('\n# Canon (consistency marks — obey strictly)', canon.block);
  }
  const meta: string[] = [];
  if (story.meta.audienceMax != null) meta.push(`Audience: ages ${story.meta.audienceMin ?? '?'}–${story.meta.audienceMax}`);
  if (story.meta.genres.length) meta.push(`Genres: ${story.meta.genres.join(', ')}`);
  if (story.meta.tones.length) meta.push(`Tone: ${story.meta.tones.join(', ')}`);
  if (meta.length) parts.push('\n# Production metadata', meta.join('\n'));
  return parts.join('\n');
}

export interface PlanOptions {
  episodeCount: number;
  model?: string;
  effort?: ClaudeEffort;
  /** Replace an existing plan (only allowed while no planned episode is produced). */
  replace?: boolean;
}

export async function planStory(
  store: Store,
  claude: AnthropicLike,
  storyId: string,
  options: PlanOptions,
): Promise<Story> {
  const story = store.getStory(storyId);
  if (story.continuity !== 'linear') {
    throw new UserInputError('Season planning is only for linear stories. Switch the story continuity to "linear" first.');
  }
  const count = Math.floor(options.episodeCount);
  if (!Number.isFinite(count) || count < 2 || count > 50) {
    throw new UserInputError('episodeCount must be between 2 and 50.');
  }
  if (story.plan) {
    const produced = story.plan.episodes.some((e) => e.episodeId);
    if (!options.replace) {
      throw new UserInputError('A season plan already exists. Use extend to add episodes, or pass replace to re-plan.');
    }
    if (produced) {
      throw new UserInputError('Cannot replace the plan: episodes have already been produced from it. Extend it instead.');
    }
  }

  const { json, model } = await structuredCall(claude, {
    model: options.model ?? DEFAULT_DISSECT_MODEL,
    effort: options.effort ?? 'high',
    system: PLAN_SYSTEM + audienceGuard(story),
    user: `${storyContext(store, story)}\n\n# Task\nPlan a season of exactly ${count} episodes.`,
    schema: planSchema(),
    maxTokens: 32000,
  });
  const raw = json as RawPlan;
  const now = new Date().toISOString();
  const plan: StoryPlan = {
    arcSummary: raw.arc_summary ?? '',
    finale: raw.finale ?? '',
    model,
    createdAt: now,
    updatedAt: now,
    episodes: (raw.episodes ?? []).slice(0, count).map((e, i) => ({
      number: i + 1,
      title: e.title,
      synopsis: e.synopsis,
      arcNote: e.arc_note,
      episodeId: null,
    })),
  };
  if (plan.episodes.length < 2) throw new UserInputError('Planning failed: fewer than 2 episodes returned.');
  return store.setStoryPlan(storyId, plan);
}

const EXTEND_SYSTEM = `You are a season architect extending an existing serialized season.
The previous finale now becomes a mid-season turning point. Continue the arc with new episodes that build on everything planned so far and end in a NEW satisfying finale.
Follow the same rules as before: each episode has "title", "synopsis" (2-4 sentences), and "arc_note". Also return an updated "arc_summary" for the whole extended season and the new "finale".`;

export async function extendPlan(
  store: Store,
  claude: AnthropicLike,
  storyId: string,
  options: { additionalEpisodes: number; model?: string; effort?: ClaudeEffort },
): Promise<Story> {
  const story = store.getStory(storyId);
  if (!story.plan) throw new UserInputError('No season plan to extend — plan the story first.');
  const add = Math.floor(options.additionalEpisodes);
  if (!Number.isFinite(add) || add < 1 || add > 30) {
    throw new UserInputError('additionalEpisodes must be between 1 and 30.');
  }

  const existing = story.plan.episodes
    .map((e) => `Episode ${e.number}: ${e.title}\n  Synopsis: ${e.synopsis}\n  Arc: ${e.arcNote}`)
    .join('\n');

  const { json } = await structuredCall(claude, {
    model: options.model ?? story.plan.model ?? DEFAULT_DISSECT_MODEL,
    effort: options.effort ?? 'high',
    system: EXTEND_SYSTEM + audienceGuard(story),
    user: [
      storyContext(store, story),
      '\n# Season so far',
      `Arc summary: ${story.plan.arcSummary}`,
      `Previous finale (now a mid-season beat): ${story.plan.finale}`,
      existing,
      `\n# Task\nAdd exactly ${add} new episodes continuing from episode ${story.plan.episodes.length}.`,
    ].join('\n'),
    schema: planSchema(),
    maxTokens: 32000,
  });
  const raw = json as RawPlan;
  const start = story.plan.episodes.length;
  const added: PlannedEpisode[] = (raw.episodes ?? []).slice(0, add).map((e, i) => ({
    number: start + i + 1,
    title: e.title,
    synopsis: e.synopsis,
    arcNote: e.arc_note,
    episodeId: null,
  }));
  if (added.length === 0) throw new UserInputError('Extension failed: no episodes returned.');

  const plan: StoryPlan = {
    ...story.plan,
    arcSummary: raw.arc_summary || story.plan.arcSummary,
    finale: raw.finale || story.plan.finale,
    updatedAt: new Date().toISOString(),
    episodes: [...story.plan.episodes, ...added],
  };
  return store.setStoryPlan(storyId, plan);
}

// ---------------------------------------------------------------------------
// Episode generation
// ---------------------------------------------------------------------------

const EPISODE_GEN_RANDOM_SYSTEM = `You are an episode developer for an episodic (standalone) video series.
Invent the NEXT standalone episode: a fresh, self-contained story that reuses the canonical characters, world, and tone.

Rules:
- Do NOT repeat or closely resemble any existing episode listed by the user — new goal, new gag, new discovery.
- "title": short and catchy. "brief": 2-4 sentences (goal, obstacle, resolution).
- "setting_markdown": only when the series uses per-episode settings — a short setting document for this episode; otherwise an empty string.
- Stay strictly inside the bible, canon, and safety rails.`;

const EPISODE_GEN_LINEAR_SYSTEM = `You are an episode developer for a serialized video series.
Develop the NEXT episode of the season from its planned slot, honoring everything that already happened.

Rules:
- Follow the planned synopsis and arc note for this slot; refine, don't contradict.
- The "brief" (3-5 sentences) must flow from the previous episodes' events and set up what the arc needs next, while still telling one complete mini-story.
- Do not resolve future arc beats early and do not spoil the finale.
- "setting_markdown": only when the series uses per-episode settings; otherwise empty string.
- Stay strictly inside the bible, canon, and safety rails.`;

function episodeSchema() {
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

function recapEpisodes(store: Store, episodes: Episode[]): string {
  if (episodes.length === 0) return '(none yet — this is the first episode)';
  return episodes
    .map((e, i) => {
      const storylines = store.listProjectsByEpisode(e.id);
      const logline = storylines[0]?.storyline.logline;
      return `${i + 1}. ${e.title} — ${e.brief}${logline ? ` (storyline: ${logline})` : ''}`;
    })
    .join('\n');
}

export interface GenerateEpisodeOptions {
  runtimeSec?: number;
  model?: string;
  effort?: ClaudeEffort;
  /** Optional steer for random episodes ("make it about the pond"). */
  guidance?: string;
}

/**
 * Auto-generate the next episode of a story. Random stories get a fresh
 * standalone episode; linear stories produce the next unproduced slot from
 * the season plan with full continuity context.
 */
export async function generateNextEpisode(
  store: Store,
  claude: AnthropicLike,
  storyId: string,
  options: GenerateEpisodeOptions = {},
): Promise<Episode> {
  const story = store.getStory(storyId);
  assertRuntime(options.runtimeSec);
  const existing = store.listEpisodes(storyId);

  let system: string;
  const user: string[] = [storyContext(store, story)];
  let plannedNumber: number | null = null;

  if (story.continuity === 'linear') {
    if (!story.plan) {
      throw new UserInputError('This is a linear story with no season plan yet — plan the season first.');
    }
    const slot = story.plan.episodes.find((e) => !e.episodeId);
    if (!slot) {
      throw new UserInputError('All planned episodes have been produced. Extend the season plan to continue the story.');
    }
    plannedNumber = slot.number;
    system = EPISODE_GEN_LINEAR_SYSTEM;
    user.push(
      '\n# Season arc',
      `Arc summary: ${story.plan.arcSummary}`,
      `Finale (do not spoil early): ${story.plan.finale}`,
      '\n# Previous episodes (recap)',
      recapEpisodes(store, existing),
      '\n# This episode — planned slot',
      `Episode ${slot.number} of ${story.plan.episodes.length}: ${slot.title}`,
      `Planned synopsis: ${slot.synopsis}`,
      `Arc note: ${slot.arcNote}`,
    );
    const next = story.plan.episodes.find((e) => e.number === slot.number + 1);
    if (next) user.push(`\n# Next planned episode (set up, do not tell): ${next.title} — ${next.synopsis}`);
  } else {
    system = EPISODE_GEN_RANDOM_SYSTEM;
    user.push(
      `\n# Series setting mode: ${story.settingMode}`,
      '\n# Existing episodes (do not repeat these)',
      recapEpisodes(store, existing),
    );
    if (options.guidance?.trim()) user.push(`\n# Director guidance\n${options.guidance.trim()}`);
  }
  user.push(`\n# Target runtime: ${formatRuntime(options.runtimeSec ?? story.meta.episodeLengthSec ?? 60)}`);
  if (story.continuity === 'linear') user.push(`# Series setting mode: ${story.settingMode}`);

  const { json } = await structuredCall(claude, {
    model: options.model ?? DEFAULT_DISSECT_MODEL,
    effort: options.effort ?? 'medium',
    system: system + audienceGuard(story),
    user: user.join('\n'),
    schema: episodeSchema(),
  });
  const raw = json as { title: string; brief: string; setting_markdown: string };

  const episode = store.createEpisode(storyId, {
    title: raw.title?.trim() || `Episode ${existing.length + 1}`,
    brief: raw.brief?.trim() ?? '',
    setting: story.settingMode === 'per-episode' ? (raw.setting_markdown ?? '').trim() || undefined : undefined,
    runtimeSec: options.runtimeSec ?? null,
    plannedNumber,
  });

  // Link the plan slot to the produced episode.
  if (plannedNumber != null && story.plan) {
    const plan: StoryPlan = {
      ...story.plan,
      updatedAt: new Date().toISOString(),
      episodes: story.plan.episodes.map((e) => (e.number === plannedNumber ? { ...e, episodeId: episode.id } : e)),
    };
    store.setStoryPlan(storyId, plan);
  }
  return episode;
}

// ---------------------------------------------------------------------------
// Continuity context for storyline generation
// ---------------------------------------------------------------------------

/**
 * Build the continuity block injected into storyline prompts: serialized
 * stories get the arc position + recap; episodic stories get a standalone
 * directive.
 */
export function buildContinuityBlock(store: Store, story: Story, episode: Episode): string {
  if (story.continuity !== 'linear') {
    return [
      'Continuity mode: RANDOM (episodic).',
      'This episode is fully standalone: do not reference events from other episodes.',
      'Reuse the canonical characters, world, and tone exactly as defined.',
    ].join('\n');
  }

  const episodes = store.listEpisodes(story.id);
  const previous = episodes.filter((e) => e.id !== episode.id && e.createdAt < episode.createdAt);
  const lines = ['Continuity mode: LINEAR (serialized).'];
  if (story.plan) {
    const slot = episode.plannedNumber != null ? story.plan.episodes.find((e) => e.number === episode.plannedNumber) : undefined;
    lines.push(`Season arc: ${story.plan.arcSummary}`);
    if (slot) {
      lines.push(`This is episode ${slot.number} of ${story.plan.episodes.length}: ${slot.title}.`);
      lines.push(`This episode's role in the arc: ${slot.arcNote}`);
      const next = story.plan.episodes.find((e) => e.number === (slot.number ?? 0) + 1);
      if (next) lines.push(`Next episode (set up subtly, do not resolve): ${next.title} — ${next.synopsis}`);
      if (slot.number < story.plan.episodes.length) {
        lines.push(`Season finale (do NOT reveal or resolve yet): ${story.plan.finale}`);
      } else {
        lines.push(`This is the season finale — deliver the ending: ${story.plan.finale}`);
      }
    }
  }
  lines.push('Previously in the series:');
  lines.push(recapEpisodes(store, previous));
  lines.push('The storyline must be consistent with everything above and flow naturally from the previous episode.');
  return lines.join('\n');
}
