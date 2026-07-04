import { generateStoryline, type AnthropicLike, type StorylineInput } from '../clients/claude';
import { collectValidationIssues } from '../clients/pixverse';
import { DEFAULT_CLAUDE_MODEL, SHORT_DEFAULTS } from '../constants';
import { canonForStory } from './canon';
import { detectSceneReferences, syncCharactersFromCanon } from './characters';
import { buildContinuityBlock } from './season';
import { UserInputError } from '../errors';
import type { Store } from '../store/store';
import { makeId } from '../store/store';
import type { Clip, Project, Scene, Storyline, YoutubeMeta } from '../types';
import type { ClaudeEffort } from '../constants';

export interface CreateStorylineOptions {
  model?: string;
  effort?: ClaudeEffort;
  sceneCount?: number;
  guidance?: string;
  aspectRatio?: StorylineInput['aspectRatio'];
  pixverseModel?: StorylineInput['pixverseModel'];
  quality?: StorylineInput['quality'];
  duration?: StorylineInput['duration'];
  motionMode?: StorylineInput['motionMode'];
  structure?: StorylineInput['structure'];
}

function idleClip(sceneId: string): Clip {
  return {
    sceneId,
    status: 'idle',
    videoId: null,
    url: null,
    error: null,
    attempts: [],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Build the storyline context for an episode: the story bible, plus the
 * per-episode setting override when the story runs in per-episode mode.
 */
export function buildStorylineContext(store: Store, storyId: string, episodeId: string): {
  bible: string;
  settingOverride?: string;
} {
  const story = store.getStory(storyId);
  const bible = store.getBible(storyId);
  let settingOverride: string | undefined;
  if (story.settingMode === 'per-episode') {
    const setting = store.getSetting(episodeId);
    if (setting.trim()) settingOverride = setting;
  }
  return { bible, settingOverride };
}

/** Merge the canon's global avoid-list into a scene negative prompt (deduped). */
export function mergeNegativePrompt(sceneNegative: string, canonNegative: string): string {
  if (!canonNegative.trim()) return sceneNegative;
  const existing = new Set(
    sceneNegative
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );
  const additions = canonNegative
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t && !existing.has(t.toLowerCase()));
  if (additions.length === 0) return sceneNegative;
  return sceneNegative.trim() ? `${sceneNegative.trim()}, ${additions.join(', ')}` : additions.join(', ');
}

/** Generate a storyline for an episode and persist it as a new project. */
export async function createStorylineProject(
  store: Store,
  claude: AnthropicLike,
  storyId: string,
  episodeId: string,
  options: CreateStorylineOptions = {},
): Promise<Project> {
  const episode = store.getEpisode(episodeId);
  if (episode.storyId !== storyId) {
    throw new Error('Episode does not belong to the given story');
  }
  const story = store.getStory(storyId);
  const { bible, settingOverride } = buildStorylineContext(store, storyId, episodeId);
  const canon = canonForStory(store, story);
  const runtimeSec = episode.runtimeSec ?? story.meta.episodeLengthSec ?? 60;

  const generated = await generateStoryline(claude, {
    bible,
    episodeTitle: episode.title,
    episodeBrief: episode.brief,
    settingOverride,
    meta: story.meta,
    canonBlock: canon?.block,
    continuityBlock: buildContinuityBlock(store, story, episode),
    runtimeSec,
    model: options.model ?? DEFAULT_CLAUDE_MODEL,
    effort: options.effort,
    sceneCount: options.sceneCount,
    guidance: options.guidance,
    structure: options.structure,
    aspectRatio: options.aspectRatio ?? SHORT_DEFAULTS.aspectRatio,
    pixverseModel: options.pixverseModel,
    quality: options.quality,
    duration: options.duration,
    motionMode: options.motionMode,
  });

  // Guarantee the canon's global avoid-list reaches every rendered scene.
  if (canon?.negativePrompt) {
    for (const scene of generated.scenes) {
      scene.negativePrompt = mergeNegativePrompt(scene.negativePrompt, canon.negativePrompt);
    }
  }

  // Auto-link each scene to the canon characters AND locations named in it, so
  // the director can review those references and their approved reference images
  // are sent to PixVerse when the scene renders.
  if (canon) {
    syncCharactersFromCanon(store, storyId);
    for (const scene of generated.scenes) {
      const ids = detectSceneReferences(store, story, `${scene.heading} ${scene.description} ${scene.prompt}`);
      if (ids.length > 0) scene.referenceCharacterIds = ids;
    }
  }

  const now = new Date().toISOString();
  const storyline: Storyline = {
    id: makeId('sl'),
    storyId,
    episodeId,
    title: generated.title,
    logline: generated.logline,
    model: generated.model,
    effort: generated.effort,
    canonVersion: canon?.version ?? null,
    scenes: generated.scenes,
    youtube: generated.youtube,
    createdAt: now,
    updatedAt: now,
  };

  const clips: Record<string, Clip> = {};
  for (const scene of storyline.scenes) clips[scene.id] = idleClip(scene.id);

  return store.saveProject({ storyline, clips, publish: null });
}

function touch(project: Project): void {
  project.storyline.updatedAt = new Date().toISOString();
}

/** Patch a scene's generation parameters; resets that scene's clip so it re-renders. */
export function updateScene(store: Store, storylineId: string, sceneId: string, patch: Partial<Scene>): Project {
  const project = store.getProject(storylineId);
  const scene = project.storyline.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`Scene not found: ${sceneId}`);

  // Only allow editable fields; never let a patch overwrite id/order arbitrarily.
  const editable: (keyof Scene)[] = [
    'heading',
    'description',
    'prompt',
    'negativePrompt',
    'duration',
    'aspectRatio',
    'model',
    'quality',
    'motionMode',
    'style',
    'cameraMovement',
    'imageId',
    'imageUrl',
    'referenceCharacterIds',
    'primaryReferenceId',
    'caption',
    'seed',
  ];
  for (const key of editable) {
    if (key in patch && patch[key] !== undefined) {
      (scene as unknown as Record<string, unknown>)[key] = patch[key];
    }
  }

  // Validate the resulting scene as a generation request.
  const issues = collectValidationIssues(
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
      seed: scene.seed,
    },
    { requireImage: typeof scene.imageId === 'number' },
  );
  if (issues.length > 0) {
    throw Object.assign(new Error(`Invalid scene parameters: ${issues.join(' ')}`), { issues });
  }

  // Editing invalidates any rendered clip.
  project.clips[sceneId] = idleClip(sceneId);
  touch(project);
  return store.saveProject(project);
}

export function addScene(store: Store, storylineId: string, partial?: Partial<Scene>): Project {
  const project = store.getProject(storylineId);
  const order = project.storyline.scenes.length;
  const scene: Scene = {
    id: makeId('scene'),
    order,
    heading: partial?.heading ?? `Scene ${order + 1}`,
    description: partial?.description ?? '',
    prompt: partial?.prompt ?? '',
    negativePrompt: partial?.negativePrompt ?? '',
    duration: partial?.duration ?? SHORT_DEFAULTS.duration,
    aspectRatio: partial?.aspectRatio ?? SHORT_DEFAULTS.aspectRatio,
    model: partial?.model ?? SHORT_DEFAULTS.model,
    quality: partial?.quality ?? SHORT_DEFAULTS.quality,
    motionMode: partial?.motionMode ?? SHORT_DEFAULTS.motionMode,
    style: partial?.style ?? 'none',
    cameraMovement: partial?.cameraMovement ?? 'none',
  };
  project.storyline.scenes.push(scene);
  project.clips[scene.id] = idleClip(scene.id);
  touch(project);
  return store.saveProject(project);
}

export function removeScene(store: Store, storylineId: string, sceneId: string): Project {
  const project = store.getProject(storylineId);
  project.storyline.scenes = project.storyline.scenes.filter((s) => s.id !== sceneId);
  project.storyline.scenes.forEach((s, i) => (s.order = i));
  delete project.clips[sceneId];
  touch(project);
  return store.saveProject(project);
}

/** Reorder scenes to match the provided list of scene ids. */
export function reorderScenes(store: Store, storylineId: string, orderedIds: string[]): Project {
  const project = store.getProject(storylineId);
  const byId = new Map(project.storyline.scenes.map((s) => [s.id, s]));
  const reordered: Scene[] = [];
  for (const id of orderedIds) {
    const scene = byId.get(id);
    if (scene) {
      reordered.push(scene);
      byId.delete(id);
    }
  }
  // Append any scenes that were omitted from the ordering, preserving them.
  for (const remaining of byId.values()) reordered.push(remaining);
  reordered.forEach((s, i) => (s.order = i));
  project.storyline.scenes = reordered;
  touch(project);
  return store.saveProject(project);
}

export function updateYoutubeMeta(store: Store, storylineId: string, patch: Partial<YoutubeMeta>): Project {
  const project = store.getProject(storylineId);
  project.storyline.youtube = { ...project.storyline.youtube, ...patch };
  touch(project);
  return store.saveProject(project);
}

/** Render parameters that can be set once and applied across every scene. */
export interface SceneDefaults {
  aspectRatio?: string;
  quality?: string;
  model?: string;
  motionMode?: string;
  style?: string;
  cameraMovement?: string;
}
const SCENE_DEFAULT_FIELDS: (keyof SceneDefaults)[] = [
  'aspectRatio',
  'quality',
  'model',
  'motionMode',
  'style',
  'cameraMovement',
];

export interface ApplySceneDefaultsResult {
  project: Project;
  /** Scene ids actually changed. */
  applied: string[];
  /** Scenes left unchanged because the new value would make them invalid. */
  skipped: Array<{ sceneId: string; heading: string; issues: string[] }>;
  /** The fields that were applied. */
  fields: string[];
}

function sceneIssues(scene: Scene): string[] {
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

/**
 * Apply one set of render defaults (aspect ratio, quality, …) to every scene at
 * once — the "set it once for the whole short" control. A scene is skipped
 * (left untouched) if the new value would make it invalid, so a bulk change can
 * never push scenes into an unrenderable state; changed scenes have their clip
 * reset, matching a per-scene edit.
 */
export function applySceneDefaults(store: Store, storylineId: string, defaults: SceneDefaults): ApplySceneDefaultsResult {
  const project = store.getProject(storylineId);
  const fields = SCENE_DEFAULT_FIELDS.filter((f) => defaults[f] !== undefined && defaults[f] !== '');
  if (fields.length === 0) throw new UserInputError('Provide at least one setting to apply to all scenes.');

  const applied: string[] = [];
  const skipped: ApplySceneDefaultsResult['skipped'] = [];

  for (const scene of project.storyline.scenes) {
    const candidate = { ...scene } as Scene;
    for (const f of fields) (candidate as unknown as Record<string, unknown>)[f] = defaults[f];
    const issues = sceneIssues(candidate);
    if (issues.length > 0) {
      skipped.push({ sceneId: scene.id, heading: scene.heading, issues });
      continue;
    }
    let changed = false;
    for (const f of fields) {
      if (scene[f] !== defaults[f]) {
        (scene as unknown as Record<string, unknown>)[f] = defaults[f];
        changed = true;
      }
    }
    if (changed) {
      project.clips[scene.id] = idleClip(scene.id);
      applied.push(scene.id);
    }
  }

  touch(project);
  store.saveProject(project);
  return { project, applied, skipped, fields };
}

export { idleClip };
