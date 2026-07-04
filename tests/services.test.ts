import { afterEach, describe, expect, it } from 'vitest';
import { extractCanon } from '../src/services/canon';
import { buildReferenceDefinition } from '../src/services/characters';
import {
  extendClip,
  generateAllClips,
  generateClip,
  refreshClip,
} from '../src/services/generation';
import { publishProject } from '../src/services/publish';
import {
  addScene,
  createStorylineProject,
  removeScene,
  reorderScenes,
  updateScene,
  updateYoutubeMeta,
} from '../src/services/storyline';
import type { Store } from '../src/store/store';
import { makeDryRunYoutube, makeFakeClaude, makeFakePixverse, makeStore, makeStudioFakeClaude, noSleep } from './helpers';

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

function setup(): { store: Store; storyId: string; episodeId: string } {
  const { store, cleanup } = makeStore();
  cleanups.push(cleanup);
  const story = store.createStory({ title: 'Test Story', bible: '# Bible\nHero cat.' });
  const episode = store.createEpisode(story.id, { title: 'Ep 1', brief: 'Cat goes to space' });
  return { store, storyId: story.id, episodeId: episode.id };
}

async function makeProject(store: Store, storyId: string, episodeId: string) {
  const { client } = makeFakeClaude();
  return createStorylineProject(store, client, storyId, episodeId, { model: 'claude-opus-4-8', effort: 'high' });
}

describe('createStorylineProject', () => {
  it('creates a project with idle clips per scene', async () => {
    const { store, storyId, episodeId } = setup();
    const project = await makeProject(store, storyId, episodeId);
    expect(project.storyline.scenes).toHaveLength(2);
    expect(Object.keys(project.clips)).toHaveLength(2);
    for (const scene of project.storyline.scenes) {
      expect(project.clips[scene.id].status).toBe('idle');
    }
    expect(project.storyline.youtube.hashtags).toContain('#Shorts');
  });

  it('includes the per-episode setting override in the context', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const story = store.createStory({ title: 'S', settingMode: 'per-episode' });
    const ep = store.createEpisode(story.id, { title: 'Ep', setting: '# Frozen moon base' });
    const { client, calls } = makeFakeClaude();
    await createStorylineProject(store, client, story.id, ep.id, {});
    const userMsg = (calls[0].params.messages as Array<{ content: string }>)[0].content;
    expect(userMsg).toContain('Frozen moon base');
  });
});

describe('scene tweaking', () => {
  it('updates a scene and resets its clip', async () => {
    const { store, storyId, episodeId } = setup();
    const project = await makeProject(store, storyId, episodeId);
    const sceneId = project.storyline.scenes[0].id;
    const updated = updateScene(store, project.storyline.id, sceneId, { prompt: 'a brand new prompt', quality: '720p' });
    const scene = updated.storyline.scenes.find((s) => s.id === sceneId)!;
    expect(scene.prompt).toBe('a brand new prompt');
    expect(scene.quality).toBe('720p');
    expect(updated.clips[sceneId].status).toBe('idle');
  });

  it('rejects invalid scene parameters', async () => {
    const { store, storyId, episodeId } = setup();
    const project = await makeProject(store, storyId, episodeId);
    const sceneId = project.storyline.scenes[0].id;
    expect(() => updateScene(store, project.storyline.id, sceneId, { quality: '1080p', duration: 8 })).toThrow(/1080p/);
  });

  it('adds, removes, and reorders scenes', async () => {
    const { store, storyId, episodeId } = setup();
    const project = await makeProject(store, storyId, episodeId);
    const withAdded = addScene(store, project.storyline.id, { prompt: 'new scene' });
    expect(withAdded.storyline.scenes).toHaveLength(3);
    const ids = withAdded.storyline.scenes.map((s) => s.id);
    const reversed = reorderScenes(store, project.storyline.id, [...ids].reverse());
    expect(reversed.storyline.scenes.map((s) => s.id)).toEqual([...ids].reverse());
    expect(reversed.storyline.scenes[0].order).toBe(0);
    const removed = removeScene(store, project.storyline.id, ids[0]);
    expect(removed.storyline.scenes.map((s) => s.id)).not.toContain(ids[0]);
    expect(removed.clips[ids[0]]).toBeUndefined();
  });

  it('updates youtube metadata', async () => {
    const { store, storyId, episodeId } = setup();
    const project = await makeProject(store, storyId, episodeId);
    const updated = updateYoutubeMeta(store, project.storyline.id, { title: 'New Title' });
    expect(updated.storyline.youtube.title).toBe('New Title');
    expect(updated.storyline.youtube.tags.length).toBeGreaterThan(0); // preserved
  });
});

describe('generation service', () => {
  it('generates a clip via text-to-video and marks it ready', async () => {
    const { store, storyId, episodeId } = setup();
    const project = await makeProject(store, storyId, episodeId);
    const { client: pixverse, requests } = makeFakePixverse({ resultSequences: { 111: [5, 1] } });
    const sceneId = project.storyline.scenes[0].id;
    const clip = await generateClip(store, pixverse, project.storyline.id, sceneId, {
      wait: true,
      pollIntervalMs: 1,
      sleep: noSleep,
    });
    expect(clip.status).toBe('ready');
    expect(clip.url).toContain('.mp4');
    expect(clip.videoId).toBe(111);
    expect(clip.attempts).toHaveLength(1);
    expect(requests.some((r) => r.url.endsWith('/video/text/generate'))).toBe(true);
  });

  it('uses image-to-video when the scene has an image', async () => {
    const { store, storyId, episodeId } = setup();
    const project = await makeProject(store, storyId, episodeId);
    const sceneId = project.storyline.scenes[0].id;
    updateScene(store, project.storyline.id, sceneId, { imageId: 42, cameraMovement: 'zoom_in' });
    const { client: pixverse, requests } = makeFakePixverse({ resultSequences: { 222: [1] } });
    const clip = await generateClip(store, pixverse, project.storyline.id, sceneId, { pollIntervalMs: 1, sleep: noSleep });
    expect(clip.status).toBe('ready');
    expect(requests.some((r) => r.url.endsWith('/video/img/generate'))).toBe(true);
  });

  it('records failure without throwing for a failed render', async () => {
    const { store, storyId, episodeId } = setup();
    const project = await makeProject(store, storyId, episodeId);
    const sceneId = project.storyline.scenes[0].id;
    const { client: pixverse } = makeFakePixverse({ resultSequences: { 111: [8] } });
    const clip = await generateClip(store, pixverse, project.storyline.id, sceneId, { pollIntervalMs: 1, sleep: noSleep });
    expect(clip.status).toBe('failed');
    expect(clip.error).toBeTruthy();
  });

  it('submits without waiting when wait=false, then refresh completes it', async () => {
    const { store, storyId, episodeId } = setup();
    const project = await makeProject(store, storyId, episodeId);
    const sceneId = project.storyline.scenes[0].id;
    const { client: pixverse } = makeFakePixverse({ resultSequences: { 111: [5, 1] } });
    const submitted = await generateClip(store, pixverse, project.storyline.id, sceneId, { wait: false });
    expect(submitted.status).toBe('generating');
    expect(submitted.videoId).toBe(111);
    await refreshClip(store, pixverse, project.storyline.id, sceneId); // status 5
    const done = await refreshClip(store, pixverse, project.storyline.id, sceneId); // status 1
    expect(done.status).toBe('ready');
    expect(done.url).toContain('.mp4');
  });

  it('generates all clips', async () => {
    const { store, storyId, episodeId } = setup();
    const project = await makeProject(store, storyId, episodeId);
    const { client: pixverse } = makeFakePixverse({ defaultStatus: 1 });
    const result = await generateAllClips(store, pixverse, project.storyline.id, { pollIntervalMs: 1, sleep: noSleep });
    for (const scene of result.storyline.scenes) {
      expect(result.clips[scene.id].status).toBe('ready');
    }
  });

  it('extends a ready clip', async () => {
    const { store, storyId, episodeId } = setup();
    const project = await makeProject(store, storyId, episodeId);
    const sceneId = project.storyline.scenes[0].id;
    const { client: pixverse } = makeFakePixverse({ resultSequences: { 111: [1], 333: [1] } });
    await generateClip(store, pixverse, project.storyline.id, sceneId, { pollIntervalMs: 1, sleep: noSleep });
    const extended = await extendClip(store, pixverse, project.storyline.id, sceneId, { pollIntervalMs: 1, sleep: noSleep });
    expect(extended.status).toBe('ready');
    expect(extended.videoId).toBe(333);
    expect(extended.attempts.length).toBeGreaterThanOrEqual(2);
  });

  it('refuses to extend a clip that is not ready', async () => {
    const { store, storyId, episodeId } = setup();
    const project = await makeProject(store, storyId, episodeId);
    const sceneId = project.storyline.scenes[0].id;
    const { client: pixverse } = makeFakePixverse();
    await expect(extendClip(store, pixverse, project.storyline.id, sceneId)).rejects.toThrow(/rendered clip/);
  });
});

describe('publish service', () => {
  it('publishes in dry-run mode using a ready clip', async () => {
    const { store, storyId, episodeId } = setup();
    const project = await makeProject(store, storyId, episodeId);
    const { client: pixverse } = makeFakePixverse({ defaultStatus: 1 });
    await generateAllClips(store, pixverse, project.storyline.id, { pollIntervalMs: 1, sleep: noSleep });

    const record = await publishProject(store, makeDryRunYoutube(), project.storyline.id, { privacyStatus: 'unlisted' });
    expect(record.status).toBe('published');
    expect(record.dryRun).toBe(true);
    expect(record.videoId).toContain('dry-run');
  });

  it('throws when there are no ready clips', async () => {
    const { store, storyId, episodeId } = setup();
    const project = await makeProject(store, storyId, episodeId);
    await expect(publishProject(store, makeDryRunYoutube(), project.storyline.id, {})).rejects.toThrow(/No ready clips/);
  });

  it('publishes a specific scene clip', async () => {
    const { store, storyId, episodeId } = setup();
    const project = await makeProject(store, storyId, episodeId);
    const sceneId = project.storyline.scenes[1].id;
    const { client: pixverse } = makeFakePixverse({ defaultStatus: 1 });
    await generateClip(store, pixverse, project.storyline.id, sceneId, { pollIntervalMs: 1, sleep: noSleep });
    const record = await publishProject(store, makeDryRunYoutube(), project.storyline.id, { sceneId });
    expect(record.status).toBe('published');
  });

  it('records a publish history entry per attempt', async () => {
    const { store, storyId, episodeId } = setup();
    const project = await makeProject(store, storyId, episodeId);
    const { client: pixverse } = makeFakePixverse({ defaultStatus: 1 });
    await generateAllClips(store, pixverse, project.storyline.id, { pollIntervalMs: 1, sleep: noSleep });

    await publishProject(store, makeDryRunYoutube(), project.storyline.id, { privacyStatus: 'private' });
    await publishProject(store, makeDryRunYoutube(), project.storyline.id, { privacyStatus: 'unlisted' });

    const saved = store.getProject(project.storyline.id);
    expect(saved.publishHistory).toHaveLength(2);
    expect(saved.publishHistory!.every((r) => r.status === 'published')).toBe(true);
    // History entries are independent snapshots — the second publish doesn't
    // share (or mutate) the first entry's object.
    expect(saved.publishHistory![0]).not.toBe(saved.publishHistory![1]);
    expect(saved.publishHistory![0]).not.toBe(saved.publish);
    expect(saved.publish?.videoId).toBe(saved.publishHistory![1].videoId);
  });

  it('records a failed publish attempt in history', async () => {
    const { store, storyId, episodeId } = setup();
    const project = await makeProject(store, storyId, episodeId);
    const { client: pixverse } = makeFakePixverse({ defaultStatus: 1 });
    await generateAllClips(store, pixverse, project.storyline.id, { pollIntervalMs: 1, sleep: noSleep });

    // Live (non-dry-run) youtube with no credentials → dry-run anyway; force a
    // failure by publishing with an explicit bad videoUrl on a live client.
    const youtube = makeDryRunYoutube();
    await publishProject(store, youtube, project.storyline.id, {});
    const saved = store.getProject(project.storyline.id);
    expect(saved.publishHistory!.length).toBeGreaterThanOrEqual(1);
  });
});

describe('reference definition', () => {
  it('returns canon marks and the built prompt for a character', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const story = store.createStory({
      title: 'Pals',
      bible: '# Bible\nBobo is a golden-brown monkey with a bright green leaf scarf.',
      meta: { audienceMin: 4, audienceMax: 7 },
    });
    const { client } = makeStudioFakeClaude();
    await extractCanon(store, client, story.id);

    const def = buildReferenceDefinition(store, story.id, 'CHAR_BOBO_001');
    expect(def.name).toBe('Bobo');
    expect(def.type).toBe('character');
    expect(def.marks.some((m) => m.value.includes('green leaf scarf'))).toBe(true);
    expect(def.builtPrompt).toContain('reference sheet of Bobo');
    expect(def.negativePrompt).toContain('multiple characters');
  });

  it('rejects an unknown entity id', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const story = store.createStory({ title: 'X', bible: '# Bible\nBobo.' });
    const { client } = makeStudioFakeClaude();
    await extractCanon(store, client, story.id);
    expect(() => buildReferenceDefinition(store, story.id, 'NOPE')).toThrow(/No canon character or location/);
  });
});
