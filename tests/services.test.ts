import { afterEach, describe, expect, it } from 'vitest';
import { autofixStoryline } from '../src/services/autofix';
import { buildCaptionsSrt } from '../src/services/captions';
import { referenceReadiness } from '../src/services/characters';
import { planStorylineDialogue } from '../src/services/dialogue';
import { suggestEpisodeIdeas } from '../src/services/ideas';
import { patchScene, regenerateScene } from '../src/services/patch';
import { createStorylineProject } from '../src/services/storyline';
import type { Store } from '../src/store/store';
import { makeFakeClaude, makeStore, makeStudioFakeClaude, samplePatchJson } from './helpers';

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

async function sceneOf(store: Store) {
  const story = store.createStory({ title: 'S', bible: '# Bible\nHero in a neon city.' });
  const episode = store.createEpisode(story.id, { title: 'E1', brief: 'x' });
  const { client } = makeFakeClaude();
  const project = await createStorylineProject(store, client, story.id, episode.id, {});
  return { storyId: story.id, storylineId: project.storyline.id, sceneId: project.storyline.scenes[0].id };
}

describe('auto-fix of invalid render parameters', () => {
  it('resolves every scene deterministically even when the LLM is unavailable', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const { storylineId, sceneId } = await sceneOf(store);
    // Force an invalid combo directly on the store (updateScene would reject it).
    const project = store.getProject(storylineId);
    const scene = project.storyline.scenes.find((s) => s.id === sceneId)!;
    scene.motionMode = 'fast';
    scene.duration = 8;
    store.saveProject(project);

    const { client: down } = makeFakeClaude(() => {
      throw new Error('gateway down');
    });
    const result = await autofixStoryline(store, down, storylineId);

    expect(result.ok).toBe(true);
    expect(result.model).toBeNull(); // fell back to the deterministic fix
    expect(store.getProject(storylineId).storyline.scenes.find((s) => s.id === sceneId)!.duration).toBe(5);
  });
});

describe('directed edits', () => {
  it('a patch rewrites the prompt and records the change; a fresh take does a full re-write', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const { storylineId, sceneId } = await sceneOf(store);

    const { client: patcher } = makeFakeClaude(() => ({
      stop_reason: 'end_turn',
      model: 'fake',
      content: [{ type: 'text', text: samplePatchJson() }],
    }));
    const { patch } = await patchScene(store, patcher, storylineId, sceneId, 'make the hero look worried');
    expect(patch.after).toContain('worried');
    expect(store.getProject(storylineId).clips[sceneId].status).toBe('idle'); // render invalidated

    const { client: regen } = makeFakeClaude(() => ({
      stop_reason: 'end_turn',
      model: 'fake',
      content: [{ type: 'text', text: JSON.stringify({ new_prompt: 'A bold low-angle take', approach: 'Reframed.' }) }],
    }));
    const fresh = await regenerateScene(store, regen, storylineId, sceneId, 'more dramatic');
    expect(fresh.patch.request).toContain('Fresh take');
    expect(store.getProject(storylineId).storyline.scenes.find((s) => s.id === sceneId)!.patchHistory).toHaveLength(2);
  });

  it('rejects an empty change request', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const { storylineId, sceneId } = await sceneOf(store);
    const { client } = makeFakeClaude();
    await expect(patchScene(store, client, storylineId, sceneId, '   ')).rejects.toThrow(/describe the change/i);
  });
});

describe('planning aids', () => {
  it('suggests distinct episode ideas grounded in the bible', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const story = store.createStory({ title: 'Show', bible: '# Bible\nBobo the monkey.' });
    const { client } = makeStudioFakeClaude();
    const ideas = await suggestEpisodeIdeas(store, client, story.id, { count: 3 });
    expect(ideas).toHaveLength(3);
    expect(ideas[0]).toHaveProperty('hook');
  });

  it('planning dialogue persists captions that drive a timed subtitle track', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const story = store.createStory({ title: 'Caps', bible: '# Bible\nHero.' });
    const episode = store.createEpisode(story.id, { title: 'E1', brief: 'x' });
    const { client } = makeStudioFakeClaude();
    const project = await createStorylineProject(store, client, story.id, episode.id, {});

    await planStorylineDialogue(store, client, project.storyline.id);
    const srt = buildCaptionsSrt(store, project.storyline.id);
    expect(srt).toContain('00:00:00,000 --> 00:00:05,000');
    expect(srt).toContain('A neon night begins!');
  });
});

describe('reference readiness', () => {
  it('reports referenced entities as unapproved until an approved image exists', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const story = store.createStory({
      title: 'PipBop',
      bible: '# Bible\nBobo lives by the Giggle Tree.',
      meta: { audienceMin: 4, audienceMax: 7 },
    });
    const mentioning = JSON.stringify({
      title: 'Q',
      logline: 'l',
      scenes: [
        {
          heading: 'At the Giggle Tree',
          description: 'Bobo arrives.',
          prompt: 'Bobo swings from the Giggle Tree',
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
      youtube: { title: 'Q', description: 'x', tags: ['a'], hashtags: ['#Shorts'] },
    });
    const { extractCanon } = await import('../src/services/canon');
    const { client } = makeStudioFakeClaude({ storylineJson: mentioning });
    await extractCanon(store, client, story.id);
    const episode = store.createEpisode(story.id, { title: 'E1', brief: 'x' });
    const project = await createStorylineProject(store, client, story.id, episode.id, {});

    const readiness = referenceReadiness(store, project.storyline.id);
    expect(readiness.ready).toBe(false);
    expect(readiness.items.find((i) => i.entityId === 'CHAR_BOBO_001')?.approved).toBe(false);
  });
});
