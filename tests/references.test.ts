import { afterEach, describe, expect, it } from 'vitest';
import { extractCanon } from '../src/services/canon';
import {
  approvePortrait,
  detectSceneReferences,
  generatePortrait,
  referenceReadiness,
  resolveSceneReferences,
} from '../src/services/characters';
import { createStorylineProject } from '../src/services/storyline';
import type { Store } from '../src/store/store';
import { makeFakePixverse, makeStore, makeStudioFakeClaude, noSleep } from './helpers';

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

/** A storyline whose scene names both a canon character (Bobo) and a location (Giggle Tree). */
function storylineMentioning(): string {
  return JSON.stringify({
    title: 'Banana Quest',
    logline: 'Bobo hunts for the perfect banana.',
    scenes: [
      {
        heading: 'At the Giggle Tree',
        description: 'Bobo arrives at the Giggle Tree.',
        prompt: 'Bobo swings from the Giggle Tree, his bright green leaf scarf fluttering',
        negative_prompt: 'scary',
        duration: 5,
        aspect_ratio: '9:16',
        model: 'v5',
        quality: '540p',
        motion_mode: 'normal',
        style: 'none',
        camera_movement: 'none',
      },
    ],
    youtube: { title: 'Banana Quest', description: 'x', tags: ['a'], hashtags: ['#Shorts'] },
  });
}

async function setup(store: Store) {
  const story = store.createStory({
    title: 'PipBop Pals',
    bible: '# Bible\nBobo wears a bright green leaf scarf and lives by the Giggle Tree.',
    meta: { audienceMin: 4, audienceMax: 7 },
  });
  const { client } = makeStudioFakeClaude({ storylineJson: storylineMentioning() });
  await extractCanon(store, client, story.id);
  const episode = store.createEpisode(story.id, { title: 'Ep 1', brief: 'banana quest' });
  const project = await createStorylineProject(store, client, story.id, episode.id, {});
  return { story, storylineId: project.storyline.id };
}

describe('scene reference auto-linking', () => {
  it('links both characters and locations named in a scene', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const { story } = await setup(store);
    const text = 'Bobo swings from the Giggle Tree';
    const ids = detectSceneReferences(store, store.getStory(story.id), text);
    // Character first, then location.
    expect(ids).toContain('CHAR_BOBO_001');
    expect(ids.some((id) => id.startsWith('LOC_'))).toBe(true);
    expect(ids.indexOf('CHAR_BOBO_001')).toBeLessThan(ids.findIndex((id) => id.startsWith('LOC_')));
  });

  it('auto-populates scene.referenceCharacterIds at storyline creation', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const { storylineId } = await setup(store);
    const scene = store.getProject(storylineId).storyline.scenes[0];
    expect(scene.referenceCharacterIds).toBeDefined();
    expect(scene.referenceCharacterIds).toContain('CHAR_BOBO_001');
    expect(scene.referenceCharacterIds!.some((id) => id.startsWith('LOC_'))).toBe(true);
  });
});

describe('referenceReadiness (pre-render approval gate)', () => {
  it('reports referenced entities as unapproved until an approved reference exists', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const { story, storylineId } = await setup(store);

    const before = referenceReadiness(store, storylineId);
    expect(before.ready).toBe(false);
    const bobo = before.items.find((i) => i.entityId === 'CHAR_BOBO_001')!;
    expect(bobo.type).toBe('character');
    expect(bobo.approved).toBe(false);
    expect(bobo.scenes).toEqual([1]);
    expect(before.items.some((i) => i.type === 'location')).toBe(true);
    expect(before.unapproved.length).toBe(before.items.length);

    // Approve Bobo's portrait → Bobo becomes ready, the location still isn't.
    const { client: pixverse } = makeFakePixverse({ resultSequences: { 111: [1] } });
    const version = await generatePortrait(store, pixverse, story.id, 'CHAR_BOBO_001', {
      wait: true,
      pollIntervalMs: 1,
      sleep: noSleep,
    });
    approvePortrait(store, story.id, 'CHAR_BOBO_001', version.id);

    const after = referenceReadiness(store, storylineId);
    expect(after.items.find((i) => i.entityId === 'CHAR_BOBO_001')!.approved).toBe(true);
    expect(after.ready).toBe(false); // location still unapproved
    expect(after.unapproved.every((i) => i.type === 'location')).toBe(true);
  });

  it('lets a scene choose which reference image seeds image-to-video', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const { story, storylineId } = await setup(store);
    const { client: pixverse } = makeFakePixverse({ resultSequences: { 111: [1] } });

    const locId = referenceReadiness(store, storylineId).items.find((i) => i.type === 'location')!.entityId;
    const imageIds: Record<string, number> = { CHAR_BOBO_001: 101, [locId]: 202 };
    for (const id of ['CHAR_BOBO_001', locId]) {
      const v = await generatePortrait(store, pixverse, story.id, id, { wait: true, pollIntervalMs: 1, sleep: noSleep });
      approvePortrait(store, story.id, id, v.id);
    }
    // Give each approved version a deterministic image id (the fake video URL yields none).
    const registry = store.getCharacterRegistry(story.id)!;
    for (const id of ['CHAR_BOBO_001', locId]) {
      const asset = registry.characters[id];
      const approved = asset.versions.find((x) => x.id === asset.approvedVersionId)!;
      approved.imageId = imageIds[id];
    }
    store.saveCharacterRegistry(registry);

    const ids = ['CHAR_BOBO_001', locId];
    // Default: the first approved image (Bobo) seeds the render.
    expect(resolveSceneReferences(store, story.id, ids).imageId).toBe(101);
    // Choosing the location as primary swaps the seed image.
    expect(resolveSceneReferences(store, story.id, ids, locId).imageId).toBe(202);
  });
});
