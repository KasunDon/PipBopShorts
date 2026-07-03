import {
  CLAUDE_EFFORTS,
  DEFAULT_CLAUDE_EFFORT,
  PIXVERSE_ASPECT_RATIOS,
  PIXVERSE_CAMERA_MOVEMENTS,
  PIXVERSE_DURATIONS,
  PIXVERSE_MODELS,
  PIXVERSE_MOTION_MODES,
  PIXVERSE_QUALITIES,
  PIXVERSE_STYLES,
  SHORT_DEFAULTS,
  getClaudeModel,
  type ClaudeEffort,
} from '../constants';
import type {
  PixverseAspectRatio,
  PixverseDuration,
  PixverseModel,
  PixverseMotionMode,
  PixverseQuality,
} from '../constants';
import type { Scene, StoryMeta, YoutubeMeta } from '../types';

/** Minimal shape of the Anthropic SDK client that this module needs. */
export interface AnthropicLike {
  messages: { create(params: Record<string, unknown>): Promise<AnthropicResponse> };
  beta: { messages: { create(params: Record<string, unknown>): Promise<AnthropicResponse> } };
}

export interface AnthropicResponse {
  stop_reason?: string;
  stop_details?: { category?: string | null; explanation?: string } | null;
  model?: string;
  content: Array<{ type: string; text?: string }>;
}

export class ClaudeError extends Error {
  constructor(
    message: string,
    readonly kind: 'refusal' | 'parse' | 'unknown-model' | 'empty' | 'unknown' = 'unknown',
  ) {
    super(message);
    this.name = 'ClaudeError';
  }
}

const EFFORT_RANK: Record<ClaudeEffort, number> = {
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
  max: 4,
};

/** Clamp a requested effort to what the chosen model supports. */
export function clampEffort(requested: ClaudeEffort | undefined, maxEffort: ClaudeEffort): ClaudeEffort {
  const eff = requested && CLAUDE_EFFORTS.includes(requested) ? requested : DEFAULT_CLAUDE_EFFORT;
  return EFFORT_RANK[eff] > EFFORT_RANK[maxEffort] ? maxEffort : eff;
}

export interface StructuredCallOptions {
  model?: string;
  effort?: ClaudeEffort;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}

export interface StructuredCallResult {
  json: unknown;
  model: string;
  effort: ClaudeEffort | null;
}

/**
 * Make a structured-output request, shaping it per model capabilities:
 * adaptive thinking where supported, effort where supported, and server-side
 * refusal fallbacks for Fable 5. Returns parsed JSON.
 */
export async function structuredCall(client: AnthropicLike, opts: StructuredCallOptions): Promise<StructuredCallResult> {
  const modelId = opts.model ?? 'claude-opus-4-8';
  const info = getClaudeModel(modelId);
  if (!info) {
    throw new ClaudeError(`Unknown Claude model: ${modelId}`, 'unknown-model');
  }

  const effort = info.supportsEffort ? clampEffort(opts.effort, info.maxEffort) : null;

  const outputConfig: Record<string, unknown> = {
    format: { type: 'json_schema', schema: opts.schema },
  };
  if (effort) outputConfig.effort = effort;

  const params: Record<string, unknown> = {
    model: modelId,
    max_tokens: opts.maxTokens ?? 16000,
    system: opts.system,
    output_config: outputConfig,
    messages: [{ role: 'user', content: opts.user }],
  };

  if (info.thinking === 'adaptive') {
    params.thinking = { type: 'adaptive' };
  }
  // 'always-on' (Fable 5) and 'none' (Haiku) both omit the thinking parameter.

  let res: AnthropicResponse;
  if (info.useFallback) {
    res = await client.beta.messages.create({
      ...params,
      betas: ['server-side-fallback-2026-06-01'],
      fallbacks: [{ model: 'claude-opus-4-8' }],
    });
  } else {
    res = await client.messages.create(params);
  }

  if (res.stop_reason === 'refusal') {
    const cat = res.stop_details?.category ?? 'unspecified';
    throw new ClaudeError(`Claude declined the request (category: ${cat}).`, 'refusal');
  }
  const textBlock = res.content?.find((b) => b.type === 'text' && typeof b.text === 'string');
  if (!textBlock || !textBlock.text) {
    throw new ClaudeError('Claude returned no text content.', 'empty');
  }
  let json: unknown;
  try {
    json = JSON.parse(textBlock.text);
  } catch (err) {
    throw new ClaudeError(`Could not parse structured JSON: ${(err as Error).message}`, 'parse');
  }
  return { json, model: modelId, effort };
}

// ---------------------------------------------------------------------------
// Storyline generation
// ---------------------------------------------------------------------------

export interface StorylineInput {
  bible: string;
  episodeTitle: string;
  episodeBrief: string;
  /** Optional per-episode setting that overrides / augments the story bible. */
  settingOverride?: string;
  /** Story production metadata (audience, genres, tone…). */
  meta?: StoryMeta;
  /** Canonical consistency block (from the canon registry) to obey. */
  canonBlock?: string;
  /** Continuity context: season arc position + recap (linear) or standalone directive (random). */
  continuityBlock?: string;
  /** Target total runtime in seconds (default 60). */
  runtimeSec?: number;
  model?: string;
  effort?: ClaudeEffort;
  /** Preferred number of scenes; the model may adjust slightly. */
  sceneCount?: number;
  aspectRatio?: PixverseAspectRatio;
  pixverseModel?: PixverseModel;
  quality?: PixverseQuality;
  duration?: PixverseDuration;
  motionMode?: PixverseMotionMode;
  /** Additional free-form guidance from the user. */
  guidance?: string;
}

export interface GeneratedStoryline {
  title: string;
  logline: string;
  scenes: Scene[];
  youtube: YoutubeMeta;
  model: string;
  effort: ClaudeEffort | null;
}

function storylineSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string' },
      logline: { type: 'string' },
      scenes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            heading: { type: 'string' },
            description: { type: 'string' },
            prompt: { type: 'string' },
            negative_prompt: { type: 'string' },
            duration: { type: 'integer', enum: [...PIXVERSE_DURATIONS] },
            aspect_ratio: { type: 'string', enum: [...PIXVERSE_ASPECT_RATIOS] },
            model: { type: 'string', enum: [...PIXVERSE_MODELS] },
            quality: { type: 'string', enum: [...PIXVERSE_QUALITIES] },
            motion_mode: { type: 'string', enum: [...PIXVERSE_MOTION_MODES] },
            style: { type: 'string', enum: [...PIXVERSE_STYLES] },
            camera_movement: { type: 'string', enum: [...PIXVERSE_CAMERA_MOVEMENTS] },
          },
          required: [
            'heading',
            'description',
            'prompt',
            'negative_prompt',
            'duration',
            'aspect_ratio',
            'model',
            'quality',
            'motion_mode',
            'style',
            'camera_movement',
          ],
        },
      },
      youtube: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          hashtags: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'description', 'tags', 'hashtags'],
      },
    },
    required: ['title', 'logline', 'scenes', 'youtube'],
  };
}

const SYSTEM_PROMPT = `You are a director and prompt engineer for AI short-form video (YouTube Shorts) generated with PixVerse.
Turn a story bible and an episode brief into a shot-by-shot storyline where every scene is a self-contained PixVerse text-to-video prompt.

Rules:
- Match the target total runtime given in the production constraints: scenes are 5 or 8 seconds each, so pick a scene count and per-scene durations that sum close to the target.
- Each scene "prompt" is a vivid, self-contained visual description (subject, action, environment, lighting, mood, camera). Do not reference other scenes by number; PixVerse renders each scene independently, so restate character/setting details each time for visual consistency.
- Keep character appearance and setting consistent across scenes by repeating concrete descriptors from the bible.
- "negative_prompt" lists things to avoid (artifacts, text overlays, extra limbs, watermarks).
- Choose per-scene "camera_movement" and "motion_mode" that fit the beat.
- The "youtube" object is publishing metadata: a punchy title (<=100 chars), an engaging description, relevant tags, and hashtags (each starting with #, include #Shorts).
Return only the structured object.`;

const CANON_DIRECTIVE = `
Canon discipline:
- A CANON section follows. Treat it as an approved film set: every LOCKED and STRONG mark must appear unchanged in the relevant scene prompts (repeat the exact descriptors).
- Marks labelled "transitioning" are mid-migration: blend from the old value toward the new one — favor the new value while keeping the character recognizable.
- Never invent changes to canonical characters, locations, props, or world rules that were not requested in the brief.`;

function kidSafetyDirective(meta: StoryMeta): string {
  return `
Child-audience discipline (ages ${meta.audienceMin ?? '?'}–${meta.audienceMax}):
- Emotionally safe at all times: no violence, weapons, fire, injury, bullying, sarcasm, insults, scary danger, dark or horror moods.
- Any accident must be harmless: soft landing, funny sound, instant happy recovery.
- Simple, visual storytelling a child can follow with the sound off; one clear goal per episode.
- Bright colors, warm lighting, friendly expressions only.
- Add the relevant avoid-terms to every scene's negative_prompt.`;
}

function metaBlock(meta: StoryMeta): string {
  const lines: string[] = ['\n# Production metadata'];
  if (meta.audienceMin != null || meta.audienceMax != null) {
    lines.push(`- Audience: ages ${meta.audienceMin ?? '?'}–${meta.audienceMax ?? '?'}${meta.audienceNotes ? ` (${meta.audienceNotes})` : ''}`);
  } else if (meta.audienceNotes) {
    lines.push(`- Audience: ${meta.audienceNotes}`);
  }
  if (meta.genres.length) lines.push(`- Genres: ${meta.genres.join(', ')}`);
  if (meta.tones.length) lines.push(`- Tone: ${meta.tones.join(', ')}`);
  if (meta.format) lines.push(`- Format: ${meta.format}`);
  if (meta.episodeLengthSec != null) lines.push(`- Target episode length: ~${meta.episodeLengthSec} seconds`);
  if (meta.language) lines.push(`- Language: ${meta.language}`);
  return lines.length > 1 ? lines.join('\n') : '';
}

function buildUserPrompt(input: StorylineInput): string {
  const parts: string[] = [];
  parts.push('# Story bible');
  parts.push(input.bible.trim() || '(none provided)');
  if (input.settingOverride && input.settingOverride.trim()) {
    parts.push('\n# Episode-specific setting (overrides/extends the bible for this episode)');
    parts.push(input.settingOverride.trim());
  }
  if (input.canonBlock && input.canonBlock.trim()) {
    parts.push('\n# CANON (version-controlled consistency marks — obey strictly)');
    parts.push(input.canonBlock.trim());
  }
  if (input.continuityBlock && input.continuityBlock.trim()) {
    parts.push('\n# CONTINUITY');
    parts.push(input.continuityBlock.trim());
  }
  if (input.meta) {
    const block = metaBlock(input.meta);
    if (block) parts.push(block);
  }
  parts.push('\n# Episode');
  parts.push(`Title: ${input.episodeTitle}`);
  parts.push(`Brief: ${input.episodeBrief.trim() || '(none)'}`);
  const runtime = input.runtimeSec ?? 60;
  const minScenes = Math.max(1, Math.ceil(runtime / 8));
  const maxScenes = Math.max(minScenes, Math.round(runtime / 5));
  parts.push('\n# Production constraints (apply as sensible defaults for every scene unless a beat clearly needs otherwise)');
  parts.push(`- Target total runtime: ~${runtime} seconds (scene durations must sum close to this; roughly ${minScenes}–${maxScenes} scenes)`);
  parts.push(`- Aspect ratio: ${input.aspectRatio ?? SHORT_DEFAULTS.aspectRatio} (vertical for Shorts)`);
  parts.push(`- Default PixVerse model: ${input.pixverseModel ?? SHORT_DEFAULTS.model}`);
  parts.push(`- Default quality: ${input.quality ?? SHORT_DEFAULTS.quality}`);
  parts.push(`- Default per-scene duration (seconds): ${input.duration ?? SHORT_DEFAULTS.duration}`);
  parts.push(`- Default motion mode: ${input.motionMode ?? SHORT_DEFAULTS.motionMode}`);
  if (input.sceneCount) parts.push(`- Target scene count: about ${input.sceneCount}`);
  if (input.guidance && input.guidance.trim()) {
    parts.push('\n# Extra guidance');
    parts.push(input.guidance.trim());
  }
  return parts.join('\n');
}

interface RawScene {
  heading: string;
  description: string;
  prompt: string;
  negative_prompt: string;
  duration: number;
  aspect_ratio: string;
  model: string;
  quality: string;
  motion_mode: string;
  style: string;
  camera_movement: string;
}

interface RawStoryline {
  title: string;
  logline: string;
  scenes: RawScene[];
  youtube: YoutubeMeta;
}

let sceneCounter = 0;
function sceneId(): string {
  sceneCounter += 1;
  return `scene_${Date.now().toString(36)}_${sceneCounter}`;
}

function coerceScene(raw: RawScene, order: number, input: StorylineInput): Scene {
  const pick = <T extends string>(value: string, allowed: readonly T[], fallback: T): T =>
    (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
  return {
    id: sceneId(),
    order,
    heading: raw.heading ?? `Scene ${order + 1}`,
    description: raw.description ?? '',
    prompt: raw.prompt ?? '',
    negativePrompt: raw.negative_prompt ?? '',
    duration: (PIXVERSE_DURATIONS as readonly number[]).includes(raw.duration)
      ? (raw.duration as PixverseDuration)
      : input.duration ?? SHORT_DEFAULTS.duration,
    aspectRatio: pick(raw.aspect_ratio, PIXVERSE_ASPECT_RATIOS, input.aspectRatio ?? SHORT_DEFAULTS.aspectRatio),
    model: pick(raw.model, PIXVERSE_MODELS, input.pixverseModel ?? SHORT_DEFAULTS.model),
    quality: pick(raw.quality, PIXVERSE_QUALITIES, input.quality ?? SHORT_DEFAULTS.quality),
    motionMode: pick(raw.motion_mode, PIXVERSE_MOTION_MODES, input.motionMode ?? SHORT_DEFAULTS.motionMode),
    style: pick(raw.style, PIXVERSE_STYLES, 'none'),
    cameraMovement: pick(raw.camera_movement, PIXVERSE_CAMERA_MOVEMENTS, 'none'),
  };
}

/**
 * Generate a storyline via Claude using structured outputs. The Anthropic client
 * is injected so this is fully testable without network access.
 */
export async function generateStoryline(
  client: AnthropicLike,
  input: StorylineInput,
): Promise<GeneratedStoryline> {
  let system = SYSTEM_PROMPT;
  if (input.canonBlock && input.canonBlock.trim()) system += CANON_DIRECTIVE;
  if (input.meta && input.meta.audienceMax != null && input.meta.audienceMax <= 12) {
    system += kidSafetyDirective(input.meta);
  }

  const { json, model, effort } = await structuredCall(client, {
    model: input.model,
    effort: input.effort,
    system,
    user: buildUserPrompt(input),
    schema: storylineSchema(),
  });

  const parsed = json as RawStoryline;
  const scenes = (parsed.scenes ?? []).map((raw, i) => coerceScene(raw, i, input));
  if (scenes.length === 0) {
    throw new ClaudeError('Storyline contained no scenes.', 'parse');
  }

  return {
    title: parsed.title ?? input.episodeTitle,
    logline: parsed.logline ?? '',
    scenes,
    youtube: {
      title: parsed.youtube?.title ?? parsed.title ?? input.episodeTitle,
      description: parsed.youtube?.description ?? '',
      tags: parsed.youtube?.tags ?? [],
      hashtags: parsed.youtube?.hashtags ?? ['#Shorts'],
    },
    model,
    effort,
  };
}
