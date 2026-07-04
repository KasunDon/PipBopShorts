import {
  PixverseError,
  ValidationError,
  type GenerationParams,
  type PixverseClient,
  type PixverseVideoResult,
} from '../clients/pixverse';
import { UserInputError } from '../errors';
import type { Store } from '../store/store';
import type { Clip, ClipAttempt, ClipStatus, Project, Scene } from '../types';
import { resolveSceneReferences, type ResolvedReferences } from './characters';

export interface GenerateOptions {
  /** Poll until the clip finishes (true) or return immediately after submitting (false). */
  wait?: boolean;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

function sceneToParams(scene: Scene, refs?: ResolvedReferences): GenerationParams {
  // Inject approved character descriptors so the render matches the reference.
  let prompt = scene.prompt;
  if (refs && refs.descriptors.length > 0) {
    const block = refs.descriptors.map((d) => `${d.name}: ${d.descriptor}`).join(' | ');
    prompt = `${prompt}\n\nCharacter references (match these approved designs exactly): ${block}`;
  }
  // An explicit scene image wins; otherwise use an approved character reference image.
  const imageId = scene.imageId ?? refs?.imageId ?? undefined;
  return {
    prompt,
    model: scene.model,
    quality: scene.quality,
    duration: scene.duration,
    motionMode: scene.motionMode,
    aspectRatio: scene.aspectRatio,
    negativePrompt: scene.negativePrompt,
    style: scene.style,
    cameraMovement: scene.cameraMovement,
    imageId: imageId ?? undefined,
  };
}

function statusFromResult(result: PixverseVideoResult): ClipStatus {
  switch (result.statusLabel) {
    case 'succeeded':
      return 'ready';
    case 'moderation_failed':
      return 'moderation_failed';
    case 'failed':
    case 'deleted':
      return 'failed';
    default:
      return 'generating';
  }
}

function getScene(project: Project, sceneId: string): Scene {
  const scene = project.storyline.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`Scene not found: ${sceneId}`);
  return scene;
}

function newAttempt(scene: Scene): ClipAttempt {
  return {
    videoId: null,
    status: 'generating',
    url: null,
    error: null,
    params: structuredClone(scene),
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
}

function finishAttempt(attempt: ClipAttempt, patch: Partial<ClipAttempt>): void {
  Object.assign(attempt, patch, { finishedAt: new Date().toISOString() });
}

/**
 * Submit a scene to PixVerse (text-to-video or image-to-video based on whether
 * the scene has a reference image), optionally polling to completion.
 */
export async function generateClip(
  store: Store,
  pixverse: PixverseClient,
  storylineId: string,
  sceneId: string,
  options: GenerateOptions = {},
): Promise<Clip> {
  const project = store.getProject(storylineId);
  const scene = getScene(project, sceneId);
  const refs = resolveSceneReferences(
    store,
    project.storyline.storyId,
    scene.referenceCharacterIds ?? [],
    scene.primaryReferenceId,
  );
  const params = sceneToParams(scene, refs);

  const attempt = newAttempt(scene);
  const clip: Clip = {
    sceneId,
    status: 'generating',
    videoId: null,
    url: null,
    error: null,
    attempts: [...(project.clips[sceneId]?.attempts ?? []), attempt],
    updatedAt: new Date().toISOString(),
  };
  project.clips[sceneId] = clip;
  store.saveProject(project);

  try {
    // Route to image-to-video whenever an image reference is available — either
    // the scene's own upload or a resolved approved character reference.
    const videoId =
      typeof params.imageId === 'number'
        ? await pixverse.generateImageToVideo(params)
        : await pixverse.generateTextToVideo(params);
    clip.videoId = videoId;
    attempt.videoId = videoId;
    clip.updatedAt = new Date().toISOString();
    store.saveProject(project);

    if (options.wait !== false) {
      const result = await pixverse.pollVideo(videoId, {
        intervalMs: options.pollIntervalMs,
        timeoutMs: options.pollTimeoutMs,
        sleep: options.sleep,
      });
      applyResult(clip, attempt, result);
    }
    store.saveProject(project);
    return clip;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status: ClipStatus = err instanceof PixverseError && /moderation/i.test(message) ? 'moderation_failed' : 'failed';
    clip.status = status;
    clip.error = message;
    clip.updatedAt = new Date().toISOString();
    finishAttempt(attempt, { status, error: message });
    store.saveProject(project);
    if (err instanceof ValidationError) throw err;
    return clip;
  }
}

function applyResult(clip: Clip, attempt: ClipAttempt, result: PixverseVideoResult): void {
  const status = statusFromResult(result);
  clip.status = status;
  clip.url = result.url;
  clip.error = status === 'ready' ? null : clip.error;
  clip.updatedAt = new Date().toISOString();
  finishAttempt(attempt, { status, url: result.url });
}

/** Poll PixVerse once for a clip that is still generating and update its state. */
export async function refreshClip(
  store: Store,
  pixverse: PixverseClient,
  storylineId: string,
  sceneId: string,
): Promise<Clip> {
  const project = store.getProject(storylineId);
  const clip = project.clips[sceneId];
  if (!clip) throw new Error(`Clip not found: ${sceneId}`);
  if (clip.videoId == null) return clip;

  const result = await pixverse.getVideoResult(clip.videoId);
  const status = statusFromResult(result);
  clip.status = status;
  if (result.url) clip.url = result.url;
  if (status === 'failed') clip.error = clip.error ?? 'Generation failed';
  if (status === 'moderation_failed') clip.error = 'Content moderation failed';
  clip.updatedAt = new Date().toISOString();
  const last = clip.attempts[clip.attempts.length - 1];
  if (last && last.finishedAt === null) finishAttempt(last, { status, url: result.url });
  store.saveProject(project);
  return clip;
}

/** Generate every scene's clip in order. */
export async function generateAllClips(
  store: Store,
  pixverse: PixverseClient,
  storylineId: string,
  options: GenerateOptions = {},
): Promise<Project> {
  const project = store.getProject(storylineId);
  for (const scene of [...project.storyline.scenes].sort((a, b) => a.order - b.order)) {
    await generateClip(store, pixverse, storylineId, scene.id, options);
  }
  return store.getProject(storylineId);
}

/** Extend a rendered clip with a continuation. Replaces the clip's video with the extended one. */
export async function extendClip(
  store: Store,
  pixverse: PixverseClient,
  storylineId: string,
  sceneId: string,
  options: GenerateOptions = {},
): Promise<Clip> {
  const project = store.getProject(storylineId);
  const scene = getScene(project, sceneId);
  const clip = project.clips[sceneId];
  if (!clip || clip.videoId == null || clip.status !== 'ready') {
    throw new Error('Can only extend a rendered clip');
  }

  const attempt = newAttempt(scene);
  attempt.videoId = clip.videoId;
  clip.attempts.push(attempt);
  clip.status = 'generating';
  clip.updatedAt = new Date().toISOString();
  store.saveProject(project);

  try {
    const newVideoId = await pixverse.extendVideo(clip.videoId, {
      prompt: scene.prompt,
      model: scene.model,
      quality: scene.quality,
      duration: scene.duration,
      motionMode: scene.motionMode,
      negativePrompt: scene.negativePrompt,
    });
    clip.videoId = newVideoId;
    attempt.videoId = newVideoId;
    if (options.wait !== false) {
      const result = await pixverse.pollVideo(newVideoId, {
        intervalMs: options.pollIntervalMs,
        timeoutMs: options.pollTimeoutMs,
        sleep: options.sleep,
      });
      applyResult(clip, attempt, result);
    }
    store.saveProject(project);
    return clip;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    clip.status = 'failed';
    clip.error = message;
    clip.updatedAt = new Date().toISOString();
    finishAttempt(attempt, { status: 'failed', error: message });
    store.saveProject(project);
    return clip;
  }
}

/**
 * Approve (or un-approve) a rendered clip as final. Only a ready clip can be
 * approved; publishing requires approval. Editing or re-rendering a scene resets
 * this (idleClip drops the flag), so approval always reflects the current render.
 */
export function setClipApproval(store: Store, storylineId: string, sceneId: string, approved: boolean): Clip {
  const project = store.getProject(storylineId);
  const clip = project.clips[sceneId];
  if (!clip) throw new Error(`Clip not found: ${sceneId}`);
  if (approved && clip.status !== 'ready') {
    throw new UserInputError('Only a rendered (ready) clip can be approved.');
  }
  clip.approved = approved;
  clip.updatedAt = new Date().toISOString();
  store.saveProject(project);
  return clip;
}

/** Upload a reference image to PixVerse for use as a scene's image-to-video source. */
export async function uploadReferenceImage(
  pixverse: PixverseClient,
  bytes: Uint8Array,
  filename?: string,
  contentType?: string,
): Promise<{ imgId: number; imgUrl: string }> {
  return pixverse.uploadImage(bytes, filename, contentType);
}
