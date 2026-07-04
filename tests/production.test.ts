import { afterEach, describe, expect, it } from 'vitest';
import { generateClip, resolveEffectivePrompt } from '../src/services/generation';
import { JobRunner } from '../src/services/jobs';
import {
  createStorylineProject,
  duplicateScene,
  duplicateStoryline,
  fixSceneRenderCombo,
  updateScene,
} from '../src/services/storyline';
import { validateStorylineForRender } from '../src/services/preview';
import type { Store } from '../src/store/store';
import { makeFakeClaude, makeFakePixverse, makeStore, noSleep } from './helpers';

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

async function storyline(store: Store) {
  const story = store.createStory({ title: 'Show', bible: '# Bible\nHero in a neon city.' });
  const episode = store.createEpisode(story.id, { title: 'E1', brief: 'chase' });
  const { client } = makeFakeClaude();
  const project = await createStorylineProject(store, client, story.id, episode.id, {});
  return project.storyline.id;
}

describe('storyline generation guardrails', () => {
  it('normalizes an invalid render combo the model emits (fast motion at 8s → 5s)', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const story = store.createStory({ title: 'Fixup', bible: '# Bible\nHero.' });
    const episode = store.createEpisode(story.id, { title: 'E1', brief: 'x' });
    const bad = sampleStoryline({ motion_mode: 'fast', duration: 8 });
    const { client } = makeFakeClaude(() => ({ stop_reason: 'end_turn', model: 'fake', content: [{ type: 'text', text: bad }] }));

    const project = await createStorylineProject(store, client, story.id, episode.id, {});

    expect(project.storyline.scenes[0].duration).toBe(5);
    expect(validateStorylineForRender(store, project.storyline.id).ok).toBe(true);
  });

  it('shortens both capped-at-5s combos in place', () => {
    const fast = { quality: '540p', duration: 8, motionMode: 'fast' };
    expect(fixSceneRenderCombo(fast)).toBe(true);
    expect(fast.duration).toBe(5);
    const hd = { quality: '1080p', duration: 8, motionMode: 'normal' };
    fixSceneRenderCombo(hd);
    expect(hd.duration).toBe(5);
  });
});

describe('scene editing', () => {
  it('rejects a parameter combination that PixVerse would reject', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const id = await storyline(store);
    const sceneId = store.getProject(id).storyline.scenes[0].id;
    expect(() => updateScene(store, id, sceneId, { quality: '1080p', duration: 8 })).toThrow();
  });

  it('duplicates a scene in place with a fresh id and cleared render state', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const id = await storyline(store);
    const before = store.getProject(id).storyline.scenes.map((s) => ({ id: s.id, prompt: s.prompt }));
    const project = duplicateScene(store, id, before[0].id);
    expect(project.storyline.scenes).toHaveLength(before.length + 1);
    expect(project.storyline.scenes[1].id).not.toBe(before[0].id);
    expect(project.storyline.scenes[1].prompt).toBe(before[0].prompt);
    expect(project.clips[project.storyline.scenes[1].id].status).toBe('idle');
  });

  it('duplicates a storyline into a clean copy, leaving the original untouched', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const id = await storyline(store);
    const copy = duplicateStoryline(store, id);
    expect(copy.storyline.id).not.toBe(id);
    expect(copy.storyline.title).toMatch(/\(copy\)$/);
    expect(copy.publish).toBeNull();
    expect(store.getProject(id).storyline.title).not.toMatch(/\(copy\)$/);
  });
});

describe('rendering', () => {
  it('routes to text-to-video without a reference image and completes on poll', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const id = await storyline(store);
    const sceneId = store.getProject(id).storyline.scenes[0].id;
    const { client: pixverse, requests } = makeFakePixverse({ defaultStatus: 1 });

    const clip = await generateClip(store, pixverse, id, sceneId, { wait: true, pollIntervalMs: 1, sleep: noSleep });

    expect(clip.status).toBe('ready');
    expect(requests.some((r) => r.url.endsWith('/video/text/generate'))).toBe(true);
  });

  it('routes to image-to-video when the scene has an image reference', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const id = await storyline(store);
    const project = store.getProject(id);
    const sceneId = project.storyline.scenes[0].id;
    project.storyline.scenes[0].imageId = 42;
    store.saveProject(project);
    const { client: pixverse, requests } = makeFakePixverse({ defaultStatus: 1 });

    await generateClip(store, pixverse, id, sceneId, { wait: true, pollIntervalMs: 1, sleep: noSleep });

    expect(requests.some((r) => r.url.endsWith('/video/img/generate'))).toBe(true);
  });

  it('records a failed render without throwing', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const id = await storyline(store);
    const sceneId = store.getProject(id).storyline.scenes[0].id;
    const { client: pixverse } = makeFakePixverse({ defaultStatus: 8 });
    const clip = await generateClip(store, pixverse, id, sceneId, { wait: true, pollIntervalMs: 1, sleep: noSleep });
    expect(clip.status).toBe('failed');
  });

  it('injects the seed and lighting into what PixVerse receives', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const id = await storyline(store);
    const sceneId = store.getProject(id).storyline.scenes[0].id;
    updateScene(store, id, sceneId, { seed: 4242, lighting: 'golden hour' });
    const { client: pixverse, requests } = makeFakePixverse({ defaultStatus: 1 });

    await generateClip(store, pixverse, id, sceneId, { wait: true, pollIntervalMs: 1, sleep: noSleep });

    const body = requests.find((r) => r.url.endsWith('/video/text/generate'))?.body as { seed?: number; prompt?: string };
    expect(body.seed).toBe(4242);
    expect(body.prompt).toContain('golden hour lighting');
    // The read-only preview shows the same effective prompt.
    expect(resolveEffectivePrompt(store, id, sceneId).prompt).toContain('golden hour lighting');
  });
});

describe('background job runner', () => {
  it('completes an async render across ticks and reports it done', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const id = await storyline(store);
    const sceneId = store.getProject(id).storyline.scenes[0].id;
    // "generating" once, then success.
    const { client: pixverse } = makeFakePixverse({ resultSequences: { 111: [5, 1] } });
    await generateClip(store, pixverse, id, sceneId, { wait: false });

    const runner = new JobRunner({ store, pixverse });
    runner.track({ kind: 'clip', storylineId: id, sceneId });
    await runner.tick(); // still generating
    await runner.tick(); // success
    expect(runner.pending()).toHaveLength(0);
    expect(store.getProject(id).clips[sceneId].status).toBe('ready');
  });

  it('resumes in-flight renders discovered in the store after a restart', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const id = await storyline(store);
    const sceneId = store.getProject(id).storyline.scenes[0].id;
    const { client: pixverse } = makeFakePixverse({ resultSequences: { 111: [5, 1] } });
    await generateClip(store, pixverse, id, sceneId, { wait: false });

    const runner = new JobRunner({ store, pixverse });
    expect(runner.resume()).toBe(1);
  });
});

/** Build a storyline JSON where scene 1 carries overridden render params. */
function sampleStoryline(scene1Overrides: Record<string, unknown>): string {
  return JSON.stringify({
    title: 'T',
    logline: 'L',
    scenes: [
      {
        heading: 'S1',
        description: 'd',
        prompt: 'a vivid shot',
        negative_prompt: 'blurry',
        duration: 5,
        aspect_ratio: '9:16',
        model: 'v5',
        quality: '540p',
        motion_mode: 'normal',
        style: 'none',
        camera_movement: 'none',
        ...scene1Overrides,
      },
    ],
    youtube: { title: 'T', description: 'd', tags: ['a'], hashtags: ['#Shorts'] },
  });
}
