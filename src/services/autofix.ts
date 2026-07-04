import { structuredCall, type AnthropicLike } from '../clients/claude';
import { collectValidationIssues } from '../clients/pixverse';
import {
  PIXVERSE_ASPECT_RATIOS,
  PIXVERSE_CAMERA_MOVEMENTS,
  PIXVERSE_DURATIONS,
  PIXVERSE_MODELS,
  PIXVERSE_MOTION_MODES,
  PIXVERSE_QUALITIES,
  PIXVERSE_STYLES,
  type ClaudeEffort,
} from '../constants';
import type { Store } from '../store/store';
import type { Scene } from '../types';
import { buildCanonBlock, currentCanonVersion, DEFAULT_DISSECT_MODEL } from './canon';
import { updateScene } from './storyline';

/** Scene parameters PixVerse renders from — the only fields auto-fix is allowed to touch. */
const PARAM_FIELDS = [
  'duration',
  'quality',
  'motionMode',
  'model',
  'aspectRatio',
  'style',
  'cameraMovement',
] as const;
type ParamField = (typeof PARAM_FIELDS)[number];

/**
 * Issues that stem from creative content (an empty or over-long prompt, a
 * missing reference image) rather than a render-parameter combination. Auto-fix
 * deliberately does NOT touch these — changing them would alter the creative
 * project — so they are surfaced as "needs a manual edit" instead.
 */
function isCreativeIssue(issue: string): boolean {
  return (
    issue.includes('prompt must not be empty') ||
    issue.includes('prompt must be 2048') ||
    issue.includes('image reference')
  );
}

export interface SceneFix {
  sceneId: string;
  sceneNumber: number;
  heading: string;
  issues: string[];
  changes: string[];
  rationale: string;
  method: 'llm' | 'deterministic';
  resolved: boolean;
  /** Issues that remain (creative ones auto-fix won't touch). */
  remaining: string[];
}

export interface AutofixResult {
  storylineId: string;
  model: string | null;
  scenesConsidered: number;
  fixedCount: number;
  fixes: SceneFix[];
  /** True when every scene now passes validation. */
  ok: boolean;
  summary: string;
}

export interface AutofixOptions {
  model?: string;
  effort?: ClaudeEffort;
}

/** Only the render parameters, extracted from a scene. */
function paramsOf(scene: Scene): Record<ParamField, unknown> {
  return {
    duration: scene.duration,
    quality: scene.quality,
    motionMode: scene.motionMode,
    model: scene.model,
    aspectRatio: scene.aspectRatio,
    style: scene.style,
    cameraMovement: scene.cameraMovement,
  };
}

function issuesFor(scene: Scene): string[] {
  return collectValidationIssues(
    {
      prompt: scene.prompt,
      model: scene.model,
      quality: scene.quality,
      duration: scene.duration,
      motionMode: scene.motionMode,
      aspectRatio: scene.aspectRatio,
      negativePrompt: scene.negativePrompt,
      style: scene.style,
      cameraMovement: scene.cameraMovement,
      imageId: scene.imageId,
    },
    { requireImage: typeof scene.imageId === 'number' },
  );
}

/** Re-check a candidate parameter set (creative fields taken from the scene as-is). */
function issuesForParams(scene: Scene, params: Partial<Record<ParamField, unknown>>): string[] {
  const merged = { ...scene, ...params } as Scene;
  return issuesFor(merged);
}

/**
 * A safe, minimal, deterministic fix for the known render-parameter constraints —
 * the fallback when the LLM is unavailable or proposes something that still fails.
 * It keeps the director's intent where it can: fast motion and 1080p are shortened
 * to 5s (preserving the chosen look) rather than downgraded.
 */
function deterministicPatch(scene: Scene): Partial<Record<ParamField, unknown>> {
  const patch: Partial<Record<ParamField, unknown>> = {};
  const model = { ...scene, ...patch } as Scene;

  // Snap out-of-range enums to safe defaults first.
  if (!PIXVERSE_MODELS.includes(model.model)) patch.model = 'v5';
  if (!PIXVERSE_QUALITIES.includes(model.quality)) patch.quality = '540p';
  if (!PIXVERSE_DURATIONS.includes(model.duration)) patch.duration = 5;
  if (!PIXVERSE_MOTION_MODES.includes(model.motionMode)) patch.motionMode = 'normal';
  if (scene.aspectRatio && !PIXVERSE_ASPECT_RATIOS.includes(scene.aspectRatio)) patch.aspectRatio = '9:16';
  if (scene.style && !PIXVERSE_STYLES.includes(scene.style)) patch.style = 'none';
  if (scene.cameraMovement && !PIXVERSE_CAMERA_MOVEMENTS.includes(scene.cameraMovement)) patch.cameraMovement = 'none';

  const q = (patch.quality ?? scene.quality) as string;
  const dur = (patch.duration ?? scene.duration) as number;
  const motion = (patch.motionMode ?? scene.motionMode) as string;
  // 1080p and fast motion are both capped at 5s — shorten rather than downgrade,
  // so the creative choice (resolution / energy) survives.
  if (q === '1080p' && dur === 8) patch.duration = 5;
  if (motion === 'fast' && dur === 8) patch.duration = 5;

  return patch;
}

function describeChanges(scene: Scene, patch: Partial<Record<ParamField, unknown>>): string[] {
  const changes: string[] = [];
  for (const key of PARAM_FIELDS) {
    if (key in patch && patch[key] !== undefined && patch[key] !== scene[key]) {
      changes.push(`${key} ${String(scene[key])}→${String(patch[key])}`);
    }
  }
  return changes;
}

function autofixSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      fixes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            scene_number: { type: 'integer' },
            duration: { type: 'integer', enum: [...PIXVERSE_DURATIONS] },
            quality: { type: 'string', enum: [...PIXVERSE_QUALITIES] },
            motion_mode: { type: 'string', enum: [...PIXVERSE_MOTION_MODES] },
            model: { type: 'string', enum: [...PIXVERSE_MODELS] },
            aspect_ratio: { type: 'string', enum: [...PIXVERSE_ASPECT_RATIOS] },
            style: { type: 'string', enum: [...PIXVERSE_STYLES] },
            camera_movement: { type: 'string', enum: [...PIXVERSE_CAMERA_MOVEMENTS] },
            rationale: { type: 'string' },
          },
          required: [
            'scene_number',
            'duration',
            'quality',
            'motion_mode',
            'model',
            'aspect_ratio',
            'style',
            'camera_movement',
            'rationale',
          ],
        },
      },
    },
    required: ['fixes'],
  };
}

const AUTOFIX_SYSTEM = `You are the technical delivery supervisor of an AI video studio.
Scenes below fail PixVerse's render rules. Choose the render PARAMETERS that make each scene valid while best serving the director's creative intent.

Hard rules you must satisfy for every scene:
- 1080p renders are capped at 5 seconds. Fast motion mode is only available at 5 seconds.
- duration ∈ {5, 8}; quality ∈ {360p, 540p, 720p, 1080p}.
- Every value you return must be from the allowed set given below.

How to choose well (this is the point — do not just normalise everything):
- Read each scene's heading, description and prompt to understand what the shot is FOR.
- A high-energy beat (a chase, an impact, a "wow" reveal) wants its fast motion kept — shorten it to 5s rather than dropping to normal motion.
- A quiet, slow, or dialogue/emotional beat can lose fast motion and keep its 8s length.
- Prefer the smallest change that fixes the rule and honours the scene's purpose.
- You may ONLY change render parameters. You may NOT rewrite the prompt, heading, or description — the creative content is fixed.
Return one fix per problem scene with a one-line rationale explaining the creative trade-off you made.`;

interface RawFix {
  scene_number: number;
  duration: number;
  quality: string;
  motion_mode: string;
  model: string;
  aspect_ratio: string;
  style: string;
  camera_movement: string;
  rationale: string;
}

/**
 * Automatically resolve render-parameter validation issues on a storyline's
 * scenes. The LLM is given the full story + canon context and each failing
 * scene's creative intent, and picks the fix that best preserves that intent
 * (e.g. keep the fast-motion energy by shortening to 5s vs. dropping to normal).
 * A deterministic fallback guarantees every parameter-fixable scene is resolved
 * even if the LLM is unavailable or proposes something that still fails.
 */
export async function autofixStoryline(
  store: Store,
  claude: AnthropicLike,
  storylineId: string,
  options: AutofixOptions = {},
): Promise<AutofixResult> {
  const project = store.getProject(storylineId);
  const story = store.getStory(project.storyline.storyId);
  const scenes = [...project.storyline.scenes].sort((a, b) => a.order - b.order);

  // Scenes with at least one parameter (non-creative) issue we can act on.
  const problems = scenes
    .map((scene, i) => ({ scene, number: i + 1, issues: issuesFor(scene) }))
    .filter((p) => p.issues.some((issue) => !isCreativeIssue(issue)));

  if (problems.length === 0) {
    return {
      storylineId,
      model: null,
      scenesConsidered: 0,
      fixedCount: 0,
      fixes: [],
      ok: scenes.every((s) => issuesFor(s).length === 0),
      summary: 'No auto-fixable parameter issues found.',
    };
  }

  // Ask the LLM to propose creatively-appropriate fixes.
  const proposals = new Map<number, RawFix>();
  let usedModel: string | null = null;
  try {
    const canon = currentCanonVersion(store.getCanonRegistry(story.id));
    const contextParts = [
      `# STORY`,
      `Title: ${story.title}`,
      project.storyline.logline ? `Logline: ${project.storyline.logline}` : '',
      story.meta.audienceMin != null || story.meta.audienceMax != null
        ? `Audience: ages ${story.meta.audienceMin ?? '?'}–${story.meta.audienceMax ?? '?'}`
        : '',
      story.meta.tones.length ? `Tone: ${story.meta.tones.join(', ')}` : '',
      story.meta.genres.length ? `Genres: ${story.meta.genres.join(', ')}` : '',
      canon ? `\n# CANON (v${canon.version})\n${buildCanonBlock(canon)}` : '',
      `\n# ALLOWED PARAMETER VALUES`,
      `duration: ${PIXVERSE_DURATIONS.join(', ')}`,
      `quality: ${PIXVERSE_QUALITIES.join(', ')}`,
      `motion_mode: ${PIXVERSE_MOTION_MODES.join(', ')}`,
      `model: ${PIXVERSE_MODELS.join(', ')}`,
      `aspect_ratio: ${PIXVERSE_ASPECT_RATIOS.join(', ')}`,
      `style: ${PIXVERSE_STYLES.join(', ')}`,
      `camera_movement: ${PIXVERSE_CAMERA_MOVEMENTS.join(', ')}`,
      `\n# PROBLEM SCENES`,
      ...problems.map((p) =>
        [
          `## Scene ${p.number}: ${p.scene.heading}`,
          p.scene.description ? `Intent: ${p.scene.description}` : '',
          `Prompt: ${p.scene.prompt}`,
          `Current params: ${JSON.stringify(paramsOf(p.scene))}`,
          `Issues: ${p.issues.filter((i) => !isCreativeIssue(i)).join(' ')}`,
        ]
          .filter(Boolean)
          .join('\n'),
      ),
    ];

    const { json, model } = await structuredCall(claude, {
      model: options.model ?? DEFAULT_DISSECT_MODEL,
      effort: options.effort ?? 'medium',
      system: AUTOFIX_SYSTEM,
      user: contextParts.filter(Boolean).join('\n'),
      schema: autofixSchema(),
      maxTokens: 8000,
    });
    usedModel = model;
    for (const fix of (json as { fixes?: RawFix[] }).fixes ?? []) {
      proposals.set(fix.scene_number, fix);
    }
  } catch {
    // LLM unavailable — the deterministic fallback below still fixes every scene.
    usedModel = null;
  }

  const fixes: SceneFix[] = [];
  let fixedCount = 0;

  for (const { scene, number, issues } of problems) {
    const proposal = proposals.get(number);
    let patch: Partial<Record<ParamField, unknown>> | null = null;
    let method: 'llm' | 'deterministic' = 'deterministic';
    let rationale = 'Applied the minimal safe parameter change.';

    if (proposal) {
      const llmPatch: Partial<Record<ParamField, unknown>> = {
        duration: proposal.duration,
        quality: proposal.quality,
        motionMode: proposal.motion_mode,
        model: proposal.model,
        aspectRatio: proposal.aspect_ratio,
        style: proposal.style,
        cameraMovement: proposal.camera_movement,
      };
      // Trust the LLM only if its parameters actually pass validation.
      if (issuesForParams(scene, llmPatch).filter((i) => !isCreativeIssue(i)).length === 0) {
        patch = llmPatch;
        method = 'llm';
        rationale = proposal.rationale || rationale;
      }
    }
    if (!patch) {
      patch = deterministicPatch(scene);
      method = 'deterministic';
    }

    const changes = describeChanges(scene, patch);
    // Apply only the fields that actually change, via updateScene (re-validates + resets the clip).
    const applyPatch: Partial<Scene> = {};
    for (const key of PARAM_FIELDS) {
      if (key in patch && patch[key] !== undefined && patch[key] !== scene[key]) {
        (applyPatch as Record<string, unknown>)[key] = patch[key];
      }
    }

    let resolved = false;
    let remaining = issues;
    if (changes.length > 0) {
      try {
        const updated = updateScene(store, storylineId, scene.id, applyPatch);
        const after = updated.storyline.scenes.find((s) => s.id === scene.id)!;
        remaining = issuesFor(after);
        resolved = remaining.filter((i) => !isCreativeIssue(i)).length === 0;
        if (resolved) fixedCount += 1;
      } catch (err) {
        // updateScene rejected the combo (shouldn't happen — we pre-validate) — leave the scene untouched.
        remaining = issuesFor(scene);
      }
    } else {
      // Nothing to change but still had issues → they must be creative-only.
      remaining = issues;
    }

    fixes.push({
      sceneId: scene.id,
      sceneNumber: number,
      heading: scene.heading,
      issues,
      changes,
      rationale,
      method,
      resolved,
      remaining: remaining.filter(isCreativeIssue),
    });
  }

  const finalProject = store.getProject(storylineId);
  const allOk = finalProject.storyline.scenes.every((s) => issuesFor(s).length === 0);
  const creativeRemaining = fixes.reduce((n, f) => n + f.remaining.length, 0);
  const summary =
    `Fixed ${fixedCount} of ${problems.length} scene(s).` +
    (creativeRemaining > 0
      ? ` ${creativeRemaining} issue(s) need a manual edit (they change the prompt or need a reference image).`
      : '');

  return {
    storylineId,
    model: usedModel,
    scenesConsidered: problems.length,
    fixedCount,
    fixes,
    ok: allOk,
    summary,
  };
}
