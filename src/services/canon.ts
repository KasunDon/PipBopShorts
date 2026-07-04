import { structuredCall, type AnthropicLike } from '../clients/claude';
import type { ClaudeEffort } from '../constants';
import type { Store } from '../store/store';
import type {
  CanonEntity,
  CanonEntityType,
  CanonRegistry,
  CanonVersion,
  ConsistencyMark,
  MarkSeverity,
  Story,
  StoryMeta,
} from '../types';

/** Default model for dissecting story bibles (user-overridable to Opus/Fable). */
export const DEFAULT_DISSECT_MODEL = 'claude-sonnet-5';
export const DISSECT_MODELS = ['claude-sonnet-5', 'claude-opus-4-8', 'claude-fable-5'] as const;

const ID_PREFIX: Record<CanonEntityType, string> = {
  character: 'CHAR',
  location: 'LOC',
  prop: 'PROP',
  relationship: 'REL',
  world_rule: 'RULE',
  visual_style: 'STYLE',
  audience_tone: 'AUD',
};

function assetSlug(name: string): string {
  return (
    name
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 24) || 'ASSET'
  );
}

/** Stable asset id in the CHAR_BOBO_001 style; version suffix = canon version. */
export function makeEntityId(type: CanonEntityType, name: string, version: number): string {
  return `${ID_PREFIX[type]}_${assetSlug(name)}_${String(version).padStart(3, '0')}`;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const ENTITY_TYPES: CanonEntityType[] = [
  'character',
  'location',
  'prop',
  'relationship',
  'world_rule',
  'visual_style',
  'audience_tone',
];

function extractionSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      entities: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: { type: 'string', enum: ENTITY_TYPES },
            name: { type: 'string' },
            summary: { type: 'string' },
            marks: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  key: { type: 'string' },
                  value: { type: 'string' },
                  severity: { type: 'string', enum: ['locked', 'strong', 'flexible'] },
                  rationale: { type: 'string' },
                },
                required: ['key', 'value', 'severity', 'rationale'],
              },
            },
          },
          required: ['type', 'name', 'summary', 'marks'],
        },
      },
      negative_prompt: { type: 'string' },
    },
    required: ['entities', 'negative_prompt'],
  };
}

const EXTRACTION_SYSTEM = `You are the continuity supervisor of an AI video production studio.
Dissect a story bible into a canonical registry of consistency marks — the facts that must stay identical (or evolve only deliberately) across every episode, so AI-generated video does not drift.

Extract entities of these types:
- character: every recurring character. See the REQUIRED character checklist below.
- location: recurring places with their fixed landmarks, palette, and lighting.
- prop: recurring signature objects.
- relationship: important character pair dynamics.
- world_rule: what is possible/impossible in this world (physics, magic, safety rules).
- visual_style: the render/animation style, camera and lighting language, color rules. See the REQUIRED visual_style marks below.
- audience_tone: target audience, tone, emotional-safety rules, content restrictions.

REQUIRED character checklist — for EVERY character, produce a mark for EACH of these keys (use the exact snake_case key), so every character is described to the SAME level of detail and never renders "a little off":
- species_build: species/type and body build (e.g. "small round robot, stocky proportions").
- colors: exact primary and secondary colors, materials/finish (e.g. "matte tangerine-orange body, cream belly, brushed-steel dish").
- face: face/head shape and notable facial features.
- eyes: eye shape, color, expression.
- signature_features: the 1-3 unmistakable, never-change identifying features (accessory, marking, silhouette).
- outfit: clothing/accessories, or "none" if unclothed.
- proportions_scale: relative size/scale (e.g. "knee-high to an adult human; head is 1/3 of body").
Set species_build, colors, signature_features to severity "locked". A character missing any of these keys is a bug — infer sensible, on-brand values from the bible rather than omitting.

REQUIRED visual_style marks (produce all three):
- style: the render/animation look, camera and lighting language.
- color_rules: the palette to use and moods/colors to avoid.
- reference_background: ONE consistent neutral backdrop to use for ALL character reference images so every reference looks like part of the same set (e.g. "seamless soft-gradient studio backdrop, warm neutral grey, even soft key light, subtle floor shadow"). This must be a single fixed description, severity "locked".

Mark severity:
- locked: must never change without an explicit canon change (signature accessories, names, species, brand colors, safety rules).
- strong: keep consistent; small contextual variation tolerated.
- flexible: useful default, free to vary.

Mark keys are short snake_case (e.g. "scarf", "fur_color", "lighting_default"). Values are concrete and renderable — write them so a video model could paint from them.
Also produce "negative_prompt": a comma-separated avoid-list for video generation distilled from the bible's forbidden content, moods, and styles.
Be exhaustive and uniform on characters — visual drift there is the most damaging.`;

interface RawExtractedMark {
  key: string;
  value: string;
  severity: MarkSeverity;
  rationale: string;
}
interface RawExtractedEntity {
  type: CanonEntityType;
  name: string;
  summary: string;
  marks: RawExtractedMark[];
}
interface RawExtraction {
  entities: RawExtractedEntity[];
  negative_prompt: string;
}

function metaToUserBlock(meta: StoryMeta): string {
  const lines: string[] = [];
  if (meta.audienceMin != null || meta.audienceMax != null) {
    lines.push(`Audience: ages ${meta.audienceMin ?? '?'}–${meta.audienceMax ?? '?'} ${meta.audienceNotes}`.trim());
  }
  if (meta.genres.length) lines.push(`Genres: ${meta.genres.join(', ')}`);
  if (meta.tones.length) lines.push(`Tone: ${meta.tones.join(', ')}`);
  if (meta.format) lines.push(`Format: ${meta.format}`);
  return lines.length ? `\n# Declared production metadata\n${lines.join('\n')}` : '';
}

/**
 * Ensure tone/audience consistency marks exist even if the bible never spells
 * them out — generated automatically from the story's declared metadata.
 */
export function ensureAudienceToneEntity(entities: CanonEntity[], meta: StoryMeta, version: number): CanonEntity[] {
  const autoMarks: ConsistencyMark[] = [];
  const mark = (key: string, value: string, severity: MarkSeverity, rationale: string): ConsistencyMark => ({
    key,
    value,
    severity,
    status: 'active',
    transition: null,
    rationale,
  });

  if (meta.audienceMin != null && meta.audienceMax != null) {
    autoMarks.push(
      mark(
        'target_audience',
        `ages ${meta.audienceMin}–${meta.audienceMax}${meta.audienceNotes ? ` (${meta.audienceNotes})` : ''}`,
        'locked',
        'Declared story metadata — every episode must stay appropriate for this audience.',
      ),
    );
  }
  if (meta.genres.length) {
    autoMarks.push(mark('genres', meta.genres.join(', '), 'strong', 'Declared story metadata.'));
  }
  if (meta.tones.length) {
    autoMarks.push(mark('tone', meta.tones.join(', '), 'strong', 'Declared story metadata.'));
  }
  if (meta.format) {
    autoMarks.push(mark('format', meta.format, 'strong', 'Declared story metadata.'));
  }
  if (autoMarks.length === 0) return entities;

  const existing = entities.find((e) => e.type === 'audience_tone');
  if (existing) {
    // Add only auto marks whose key is not already covered by the extraction.
    for (const m of autoMarks) {
      if (!existing.marks.some((x) => x.key === m.key)) existing.marks.push(m);
    }
    return entities;
  }
  return [
    ...entities,
    {
      id: makeEntityId('audience_tone', 'Audience and Tone', version),
      type: 'audience_tone',
      name: 'Audience & Tone',
      summary: 'Auto-generated from story metadata.',
      marks: autoMarks,
    },
  ];
}

export interface ExtractCanonOptions {
  model?: string;
  effort?: ClaudeEffort;
  note?: string;
}

/** Dissect the story bible into a new canon version (v1 or a re-extraction). */
export async function extractCanon(
  store: Store,
  claude: AnthropicLike,
  storyId: string,
  options: ExtractCanonOptions = {},
): Promise<CanonRegistry> {
  const story = store.getStory(storyId);
  const bible = store.getBible(storyId);
  if (!bible.trim()) throw new Error('Story bible is empty — write the bible before extracting canon.');

  const { json, model } = await structuredCall(claude, {
    model: options.model ?? DEFAULT_DISSECT_MODEL,
    effort: options.effort ?? 'high',
    system: EXTRACTION_SYSTEM,
    user: `# Story bible\n${bible}${metaToUserBlock(story.meta)}`,
    schema: extractionSchema(),
    maxTokens: 32000,
  });

  const raw = json as RawExtraction;
  const registry = store.getCanonRegistry(storyId) ?? { storyId, currentVersion: 0, versions: [] };
  const version = registry.currentVersion + 1;

  let entities: CanonEntity[] = (raw.entities ?? []).map((e) => ({
    id: makeEntityId(e.type, e.name, version),
    type: e.type,
    name: e.name,
    summary: e.summary ?? '',
    marks: (e.marks ?? []).map((m) => ({
      key: m.key,
      value: m.value,
      severity: (['locked', 'strong', 'flexible'] as const).includes(m.severity) ? m.severity : 'strong',
      status: 'active' as const,
      transition: null,
      rationale: m.rationale ?? '',
    })),
  }));
  entities = ensureAudienceToneEntity(entities, story.meta, version);

  // Preserve transitioning marks across re-extractions so a gradual acceptance
  // survives a bible re-dissection.
  const previous = currentCanonVersion(registry);
  if (previous) {
    for (const prevEntity of previous.entities) {
      for (const prevMark of prevEntity.marks) {
        if (prevMark.status !== 'transitioning') continue;
        const entity = entities.find((e) => e.type === prevEntity.type && e.name === prevEntity.name);
        const target = entity?.marks.find((m) => m.key === prevMark.key);
        if (target) {
          target.status = 'transitioning';
          target.transition = prevMark.transition;
        }
      }
    }
  }

  const newVersion: CanonVersion = {
    version,
    createdAt: new Date().toISOString(),
    source: 'extraction',
    model,
    note: options.note ?? (version === 1 ? 'Initial extraction from story bible' : 'Re-extraction from story bible'),
    entities,
    negativePrompt: (raw.negative_prompt ?? '').trim(),
  };
  registry.versions.push(newVersion);
  registry.currentVersion = version;
  store.saveCanonRegistry(registry);
  return registry;
}

export function currentCanonVersion(registry: CanonRegistry | null): CanonVersion | null {
  if (!registry || registry.versions.length === 0) return null;
  return registry.versions.find((v) => v.version === registry.currentVersion) ?? null;
}

/**
 * Deterministic canon block appended to storyline prompts. Transitioning marks
 * instruct the model to blend toward the new value (gradual acceptance).
 */
export function buildCanonBlock(version: CanonVersion): string {
  const lines: string[] = [`Canon version: ${version.version}`];
  const order: CanonEntityType[] = [
    'audience_tone',
    'visual_style',
    'world_rule',
    'character',
    'relationship',
    'location',
    'prop',
  ];
  for (const type of order) {
    for (const entity of version.entities.filter((e) => e.type === type)) {
      lines.push(`\n## ${entity.type}: ${entity.name} (${entity.id})`);
      if (entity.summary) lines.push(entity.summary);
      for (const mark of entity.marks) {
        if (mark.status === 'transitioning' && mark.transition) {
          lines.push(
            `- [${mark.severity.toUpperCase()} | TRANSITIONING] ${mark.key}: moving from "${mark.transition.from}" to "${mark.transition.to}" — blend toward the new value${mark.transition.note ? ` (${mark.transition.note})` : ''}`,
          );
        } else {
          lines.push(`- [${mark.severity.toUpperCase()}] ${mark.key}: ${mark.value}`);
        }
      }
    }
  }
  if (version.negativePrompt) {
    lines.push(`\n## Global negative prompt (merge into every scene)\n${version.negativePrompt}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Manual mark edits (also used to complete a gradual transition)
// ---------------------------------------------------------------------------

export interface MarkPatch {
  value?: string;
  severity?: MarkSeverity;
  status?: 'active' | 'transitioning';
  transitionTo?: string;
  note?: string;
}

function cloneVersion(v: CanonVersion): CanonVersion {
  return structuredClone(v);
}

/** Apply a manual mark edit as a new canon version (full history preserved). */
export function patchMark(
  store: Store,
  storyId: string,
  entityId: string,
  markKey: string,
  patch: MarkPatch,
): CanonRegistry {
  const registry = store.getCanonRegistry(storyId);
  const current = currentCanonVersion(registry);
  if (!registry || !current) throw new Error('No canon registry — extract canon first.');

  const next = cloneVersion(current);
  next.version = registry.currentVersion + 1;
  next.createdAt = new Date().toISOString();
  next.source = 'manual';
  next.model = null;
  next.note = patch.note ?? `Manual edit: ${markKey}`;

  const entity = next.entities.find((e) => e.id === entityId);
  if (!entity) throw new Error(`Canon entity not found: ${entityId}`);
  const mark = entity.marks.find((m) => m.key === markKey);
  if (!mark) throw new Error(`Consistency mark not found: ${markKey}`);

  if (patch.value !== undefined) {
    mark.value = patch.value;
    // A direct value edit completes any in-flight transition.
    mark.status = 'active';
    mark.transition = null;
  }
  if (patch.severity !== undefined) mark.severity = patch.severity;
  if (patch.status === 'transitioning') {
    if (!patch.transitionTo) throw new Error('transitionTo is required to start a transition.');
    mark.status = 'transitioning';
    mark.transition = {
      from: mark.value,
      to: patch.transitionTo,
      startedAt: new Date().toISOString(),
      note: patch.note ?? '',
    };
  } else if (patch.status === 'active' && patch.value === undefined) {
    // Completing a transition without an explicit value adopts the target.
    if (mark.transition) mark.value = mark.transition.to;
    mark.status = 'active';
    mark.transition = null;
  }

  registry.versions.push(next);
  registry.currentVersion = next.version;
  store.saveCanonRegistry(registry);
  return registry;
}

/** Story-aware helper: canon block + negative prompt for generation, if any. */
export function canonForStory(store: Store, story: Story): { block: string; negativePrompt: string; version: number } | null {
  const registry = store.getCanonRegistry(story.id);
  const current = currentCanonVersion(registry);
  if (!current) return null;
  return {
    block: buildCanonBlock(current),
    negativePrompt: current.negativePrompt,
    version: current.version,
  };
}
