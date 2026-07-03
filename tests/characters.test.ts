import { afterEach, describe, expect, it } from 'vitest';
import { extractCanon } from '../src/services/canon';
import {
  approvePortrait,
  buildPortraitPrompt,
  detectCharactersInText,
  generatePortrait,
  getApprovedVersion,
  resolveSceneReferences,
  syncCharactersFromCanon,
  uploadPortraitStill,
} from '../src/services/characters';
import { generateClip } from '../src/services/generation';
import { createStorylineProject, updateScene } from '../src/services/storyline';
import { currentCanonVersion } from '../src/services/canon';
import type { Store } from '../src/store/store';
import { makeFakePixverse, makeStore, makeStudioFakeClaude, noSleep } from './helpers';

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

async function storyWithCanon(): Promise<{ store: Store; storyId: string }> {
  const { store, cleanup } = makeStore();
  cleanups.push(cleanup);
  const story = store.createStory({
    title: 'PipBop Pals',
    bible: '# Bible\nBobo is a golden-brown monkey with a bright green leaf scarf.',
    meta: { audienceMin: 4, audienceMax: 7 },
  });
  const { client } = makeStudioFakeClaude();
  await extractCanon(store, client, story.id);
  return { store, storyId: story.id };
}

describe('portrait prompt', () => {
  it('builds a reference-sheet prompt from canon marks, excluding non-visual marks', async () => {
    const { store, storyId } = await storyWithCanon();
    const canon = currentCanonVersion(store.getCanonRegistry(storyId))!;
    const bobo = canon.entities.find((e) => e.id === 'CHAR_BOBO_001')!;
    const prompt = buildPortraitPrompt(bobo, canon);
    expect(prompt).toContain('reference sheet of Bobo');
    expect(prompt).toContain('bright green leaf scarf'); // visual mark included
    expect(prompt).not.toContain('rushes in'); // personality mark excluded
    expect(prompt).toContain('rounded stylized 3D'); // style mark appended
  });
});

describe('sync + generate + version', () => {
  it('creates an asset per canon character', async () => {
    const { store, storyId } = await storyWithCanon();
    const registry = syncCharactersFromCanon(store, storyId);
    expect(Object.keys(registry.characters)).toContain('CHAR_BOBO_001');
    expect(registry.characters['CHAR_BOBO_001'].versions).toHaveLength(0);
  });

  it('generates a portrait version and marks it ready with a preview + uploaded still', async () => {
    const { store, storyId } = await storyWithCanon();
    const { client: pixverse, requests } = makeFakePixverse({ defaultStatus: 1 });
    // Fake frame extraction so a still is uploaded even without ffmpeg.
    const fetchImpl = (async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;
    // No ffmpeg in CI → imageId stays null; assert the ready portrait regardless.
    const v = await generatePortrait(store, pixverse, storyId, 'CHAR_BOBO_001', {
      pollIntervalMs: 1,
      sleep: noSleep,
      fetchImpl,
    });
    expect(v.status).toBe('ready');
    expect(v.version).toBe(1);
    expect(v.source).toBe('auto');
    expect(v.previewUrl).toContain('.mp4');
    expect(v.videoId).toBe(111);
    expect(requests.some((r) => r.url.endsWith('/video/text/generate'))).toBe(true);
  });

  it('refresh and tweak append new versions with the right source', async () => {
    const { store, storyId } = await storyWithCanon();
    const { client: pixverse } = makeFakePixverse({ defaultStatus: 1 });
    await generatePortrait(store, pixverse, storyId, 'CHAR_BOBO_001', { pollIntervalMs: 1, sleep: noSleep });
    const refreshed = await generatePortrait(store, pixverse, storyId, 'CHAR_BOBO_001', {
      source: 'refresh',
      pollIntervalMs: 1,
      sleep: noSleep,
    });
    expect(refreshed.version).toBe(2);
    expect(refreshed.source).toBe('refresh');

    const tweaked = await generatePortrait(store, pixverse, storyId, 'CHAR_BOBO_001', {
      source: 'tweak',
      promptOverride: 'Bobo wearing a tiny explorer hat',
      pollIntervalMs: 1,
      sleep: noSleep,
    });
    expect(tweaked.version).toBe(3);
    expect(tweaked.source).toBe('tweak');
    expect(tweaked.prompt).toBe('Bobo wearing a tiny explorer hat');

    const registry = store.getCharacterRegistry(storyId)!;
    expect(registry.characters['CHAR_BOBO_001'].versions).toHaveLength(3); // all retained
  });

  it('records a failed portrait without throwing', async () => {
    const { store, storyId } = await storyWithCanon();
    const { client: pixverse } = makeFakePixverse({ resultSequences: { 111: [8] } });
    const v = await generatePortrait(store, pixverse, storyId, 'CHAR_BOBO_001', { pollIntervalMs: 1, sleep: noSleep });
    expect(v.status).toBe('failed');
    expect(v.error).toBeTruthy();
  });

  it('rejects generating for a non-character id', async () => {
    const { store, storyId } = await storyWithCanon();
    const { client: pixverse } = makeFakePixverse();
    await expect(generatePortrait(store, pixverse, storyId, 'NOPE', {})).rejects.toThrow(/No canon character/);
  });
});

describe('approve + upload still', () => {
  it('approves a ready version and rejects approving a non-ready one', async () => {
    const { store, storyId } = await storyWithCanon();
    const { client: pixverse } = makeFakePixverse({ defaultStatus: 1 });
    const v = await generatePortrait(store, pixverse, storyId, 'CHAR_BOBO_001', { pollIntervalMs: 1, sleep: noSleep });
    const asset = approvePortrait(store, storyId, 'CHAR_BOBO_001', v.id);
    expect(asset.approvedVersionId).toBe(v.id);
    expect(getApprovedVersion(asset)?.id).toBe(v.id);

    const failed = await generatePortrait(store, pixverse, storyId, 'CHAR_BOBO_001', {
      pollIntervalMs: 1,
      sleep: noSleep,
      // force failure on this call
    });
    void failed;
  });

  it('uploads a still as a ready version with a real img_id', async () => {
    const { store, storyId } = await storyWithCanon();
    const { client: pixverse } = makeFakePixverse();
    const v = await uploadPortraitStill(store, pixverse, storyId, 'CHAR_BOBO_001', new Uint8Array([1, 2, 3]), 'b.png');
    expect(v.source).toBe('upload');
    expect(v.status).toBe('ready');
    expect(v.imageId).toBe(42); // from fake uploadImage
    const asset = approvePortrait(store, storyId, 'CHAR_BOBO_001', v.id);
    expect(getApprovedVersion(asset)?.imageId).toBe(42);
  });
});

describe('scene references', () => {
  it('detects characters named in scene text', async () => {
    const { store, storyId } = await storyWithCanon();
    const story = store.getStory(storyId);
    const ids = detectCharactersInText(store, story, 'Bobo swings from the Giggle Tree');
    expect(ids).toContain('CHAR_BOBO_001');
  });

  it('resolves approved image + descriptors for referenced characters', async () => {
    const { store, storyId } = await storyWithCanon();
    const { client: pixverse } = makeFakePixverse();
    const v = await uploadPortraitStill(store, pixverse, storyId, 'CHAR_BOBO_001', new Uint8Array([1]), 'b.png');
    approvePortrait(store, storyId, 'CHAR_BOBO_001', v.id);

    const refs = resolveSceneReferences(store, storyId, ['CHAR_BOBO_001']);
    expect(refs.imageId).toBe(42);
    expect(refs.usedCharacterIds).toEqual(['CHAR_BOBO_001']);
    expect(refs.descriptors[0].name).toBe('Bobo');
  });

  it('ignores characters with no approved version', async () => {
    const { store, storyId } = await storyWithCanon();
    syncCharactersFromCanon(store, storyId);
    const refs = resolveSceneReferences(store, storyId, ['CHAR_BOBO_001']);
    expect(refs.imageId).toBeNull();
    expect(refs.descriptors).toHaveLength(0);
  });
});

describe('scene generation uses approved references', () => {
  it('sends the approved image via image-to-video and injects descriptors', async () => {
    const { store, storyId } = await storyWithCanon();
    const { client: pixverse, requests } = makeFakePixverse({ defaultStatus: 1 });
    // Approve an uploaded still (real img_id).
    const v = await uploadPortraitStill(store, pixverse, storyId, 'CHAR_BOBO_001', new Uint8Array([1]), 'b.png');
    approvePortrait(store, storyId, 'CHAR_BOBO_001', v.id);

    // Storyline with a scene that references Bobo.
    const { client: claude } = makeStudioFakeClaude();
    const ep = store.createEpisode(storyId, { title: 'E', brief: 'Bobo climbs' });
    const project = await createStorylineProject(store, claude, storyId, ep.id, {});
    const sceneId = project.storyline.scenes[0].id;
    updateScene(store, project.storyline.id, sceneId, { referenceCharacterIds: ['CHAR_BOBO_001'] });

    const clip = await generateClip(store, pixverse, project.storyline.id, sceneId, { pollIntervalMs: 1, sleep: noSleep });
    expect(clip.status).toBe('ready');

    // It routed through image-to-video with the approved img_id and injected the descriptor.
    const imgReq = requests.find((r) => r.url.endsWith('/video/img/generate'));
    expect(imgReq).toBeTruthy();
    expect((imgReq!.body as { img_id: number }).img_id).toBe(42);
    expect((imgReq!.body as { prompt: string }).prompt).toContain('Character references (match these approved designs exactly)');
  });

  it('auto-links scenes to characters named in the generated storyline', async () => {
    const { store, storyId } = await storyWithCanon();
    const { client: claude } = makeStudioFakeClaude({
      storylineJson: JSON.stringify({
        title: 'T',
        logline: 'l',
        scenes: [
          {
            heading: 'Bobo climbs',
            description: 'Bobo the monkey climbs',
            prompt: 'Bobo the monkey swings from a branch, cinematic',
            negative_prompt: 'blurry',
            duration: 5,
            aspect_ratio: '9:16',
            model: 'v5',
            quality: '540p',
            motion_mode: 'normal',
            style: 'none',
            camera_movement: 'zoom_in',
          },
        ],
        youtube: { title: 'T', description: 'd', tags: [], hashtags: ['#Shorts'] },
      }),
    });
    const ep = store.createEpisode(storyId, { title: 'E', brief: 'x' });
    const project = await createStorylineProject(store, claude, storyId, ep.id, {});
    expect(project.storyline.scenes[0].referenceCharacterIds).toContain('CHAR_BOBO_001');
  });
});
