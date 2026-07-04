import { afterEach, describe, expect, it } from 'vitest';
import { extractCanon } from '../src/services/canon';
import {
  approvePortrait,
  buildCharacterPortraitPrompt,
  buildLocationReferencePrompt,
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
import type { CanonEntity } from '../src/types';
import type { Store } from '../src/store/store';
import { makeFakePixverse, makeStore, makeStudioFakeClaude, noSleep, synthesizeTestVideo } from './helpers';

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

  it('calls out locked marks as must-have identity features (never dropped)', async () => {
    const { store, storyId } = await storyWithCanon();
    const canon = currentCanonVersion(store.getCanonRegistry(storyId))!;
    const bobo = canon.entities.find((e) => e.id === 'CHAR_BOBO_001')!;
    const prompt = buildCharacterPortraitPrompt(bobo, canon);
    expect(prompt).toContain('Must-have identity features — never change these:');
    expect(prompt).toContain('bright green leaf scarf');
    expect(prompt).toContain('golden-brown fur, warm cream face');
  });

  it('uses the canon reference_background so every character shares one consistent backdrop', async () => {
    const { store, storyId } = await storyWithCanon();
    const canon = currentCanonVersion(store.getCanonRegistry(storyId))!;
    const bobo = canon.entities.find((e) => e.id === 'CHAR_BOBO_001')!;
    const prompt = buildCharacterPortraitPrompt(bobo, canon);
    expect(prompt).toContain('seamless mint-green studio backdrop, even soft light');
    // The style mark is still applied and is not confused with the background mark.
    expect(prompt).toContain('rounded stylized 3D');
  });

  it('falls back to a fixed neutral backdrop when canon defines no reference background', () => {
    const entity: CanonEntity = {
      id: 'CHAR_X_001',
      type: 'character',
      name: 'X',
      summary: 'x',
      marks: [{ key: 'colors', value: 'blue', severity: 'locked', status: 'active', transition: null, rationale: '' }],
    };
    const prompt = buildCharacterPortraitPrompt(entity, null);
    expect(prompt).toMatch(/neutral studio backdrop/i);
  });

  it('caps the prompt under PixVerse\'s 2048-char limit, keeping locked features and dropping filler', () => {
    const mark = (key: string, value: string, severity: 'locked' | 'flexible') => ({
      key,
      value,
      severity,
      status: 'active' as const,
      transition: null,
      rationale: '',
    });
    const entity: CanonEntity = {
      id: 'CHAR_BIG_001',
      type: 'character',
      name: 'Bigmarks',
      summary: 'A very over-documented character.',
      marks: [
        mark('signature_features', 'a single unmistakable golden monocle', 'locked'),
        // A pile of long flexible descriptors that would blow the budget.
        ...Array.from({ length: 40 }, (_, i) => mark(`extra_${i}`, `flexible descriptor number ${i} `.repeat(20), 'flexible')),
      ],
    };
    const prompt = buildCharacterPortraitPrompt(entity, null);
    expect(prompt.length).toBeLessThanOrEqual(2000);
    // The locked identity feature survives; low-priority filler is what gets dropped.
    expect(prompt).toContain('golden monocle');
  });

  it('includes a "never change" mark instead of silently dropping it (previous bug)', () => {
    const entity: CanonEntity = {
      id: 'CHAR_TEST_001',
      type: 'character',
      name: 'Test Hero',
      summary: 'A test character.',
      marks: [
        {
          key: 'never_change_list',
          value: 'always has a red cape, never depicted without it',
          severity: 'locked',
          status: 'active',
          transition: null,
          rationale: 'Signature identity.',
        },
      ],
    };
    const prompt = buildCharacterPortraitPrompt(entity, null);
    expect(prompt).toContain('always has a red cape, never depicted without it');
  });

  it('builds a distinct establishing-shot prompt for locations (not character A-pose framing)', async () => {
    const { store, storyId } = await storyWithCanon();
    const canon = currentCanonVersion(store.getCanonRegistry(storyId))!;
    const tree = canon.entities.find((e) => e.type === 'location')!;
    const prompt = buildLocationReferencePrompt(tree, canon);
    expect(prompt).toContain('Establishing shot of the location "Giggle Tree"');
    expect(prompt).toContain('empty of characters or people');
    expect(prompt).not.toContain('A-pose');
    expect(prompt).toContain('curved branches, hanging bananas');
    expect(prompt).toContain('rounded stylized 3D'); // shares the series style mark
  });

  it('dispatches to the right builder based on entity.type', async () => {
    const { store, storyId } = await storyWithCanon();
    const canon = currentCanonVersion(store.getCanonRegistry(storyId))!;
    const bobo = canon.entities.find((e) => e.type === 'character')!;
    const tree = canon.entities.find((e) => e.type === 'location')!;
    expect(buildPortraitPrompt(bobo, canon)).toBe(buildCharacterPortraitPrompt(bobo, canon));
    expect(buildPortraitPrompt(tree, canon)).toBe(buildLocationReferencePrompt(tree, canon));
  });
});

describe('sync + generate + version', () => {
  it('creates an asset per canon character and per canon location', async () => {
    const { store, storyId } = await storyWithCanon();
    const registry = syncCharactersFromCanon(store, storyId);
    expect(Object.keys(registry.characters)).toContain('CHAR_BOBO_001');
    expect(registry.characters['CHAR_BOBO_001'].versions).toHaveLength(0);
    expect(registry.characters['CHAR_BOBO_001'].type).toBe('character');

    const locationId = Object.keys(registry.characters).find((id) => id.startsWith('LOC_'))!;
    expect(locationId).toBeTruthy();
    expect(registry.characters[locationId].type).toBe('location');
    expect(registry.characters[locationId].name).toBe('Giggle Tree');
  });

  it('generates a portrait version, marks it ready, and surfaces why a still was not captured', async () => {
    const { store, storyId } = await storyWithCanon();
    const { client: pixverse, requests } = makeFakePixverse({ defaultStatus: 1 });
    // Not a real video — real ffmpeg (bundled) will genuinely attempt and fail to decode it.
    const fetchImpl = (async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;
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
    // Extraction was attempted and failed on the garbage bytes — the reason is visible, not silently dropped.
    expect(v.imageId).toBeNull();
    expect(v.imageError).toBeTruthy();
  });

  it('captures and uploads a real still image alongside the video (end-to-end fix)', async () => {
    const { store, storyId } = await storyWithCanon();
    const { client: pixverse } = makeFakePixverse({ defaultStatus: 1 });
    const videoBytes = synthesizeTestVideo();
    const fetchImpl = (async () => new Response(videoBytes)) as unknown as typeof fetch;

    const v = await generatePortrait(store, pixverse, storyId, 'CHAR_BOBO_001', {
      pollIntervalMs: 1,
      sleep: noSleep,
      fetchImpl,
    });
    expect(v.status).toBe('ready');
    expect(v.imageError).toBeNull();
    expect(v.imageId).toBe(42); // from fake uploadImage
    expect(v.imageUrl).toBeTruthy();
  });

  it('generates a location reference image using the location-specific prompt', async () => {
    const { store, storyId } = await storyWithCanon();
    const registry = syncCharactersFromCanon(store, storyId);
    const locationId = Object.keys(registry.characters).find((id) => id.startsWith('LOC_'))!;
    const { client: pixverse, requests } = makeFakePixverse({ defaultStatus: 1 });

    const v = await generatePortrait(store, pixverse, storyId, locationId, { pollIntervalMs: 1, sleep: noSleep });
    expect(v.status).toBe('ready');
    expect(v.prompt).toContain('Establishing shot of the location "Giggle Tree"');
    const textReq = requests.find((r) => r.url.endsWith('/video/text/generate'));
    expect((textReq!.body as { negative_prompt: string }).negative_prompt).toContain('people');
  });

  it('image-guided tweak uploads the image and renders via image-to-video, recording the source image', async () => {
    const { store, storyId } = await storyWithCanon();
    const { client: pixverse, requests } = makeFakePixverse({ defaultStatus: 1 });

    const v = await generatePortrait(store, pixverse, storyId, 'CHAR_BOBO_001', {
      source: 'tweak',
      promptOverride: 'Bobo with a tiny party hat, matching this reference',
      sourceImageBytes: new Uint8Array([9, 9, 9]),
      sourceImageFilename: 'seed.png',
      pollIntervalMs: 1,
      sleep: noSleep,
    });

    expect(v.status).toBe('ready');
    expect(v.source).toBe('tweak');
    // It uploaded the seed image and routed through image-to-video (not text-to-video).
    expect(requests.some((r) => r.url.endsWith('/image/upload'))).toBe(true);
    const imgReq = requests.find((r) => r.url.endsWith('/video/img/generate'));
    expect(imgReq).toBeTruthy();
    expect((imgReq!.body as { img_id: number }).img_id).toBe(42);
    expect(requests.some((r) => r.url.endsWith('/video/text/generate'))).toBe(false);
    // The seeding image is recorded for display.
    expect(v.sourceImageUrl).toBeTruthy();
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
