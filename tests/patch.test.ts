import { afterEach, describe, expect, it } from 'vitest';
import { patchScene } from '../src/services/patch';
import { createStorylineProject } from '../src/services/storyline';
import type { Store } from '../src/store/store';
import { makeFakeClaude, makeStore, samplePatchJson } from './helpers';

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

async function projectWithScene(store: Store) {
  const story = store.createStory({ title: 'Patchable', bible: '# Bible\nHero in a neon city.' });
  const episode = store.createEpisode(story.id, { title: 'E1', brief: 'x' });
  const { client: claude } = makeFakeClaude();
  const project = await createStorylineProject(store, claude, story.id, episode.id, {});
  return { storylineId: project.storyline.id, sceneId: project.storyline.scenes[0].id };
}

describe('scene patch (directed edit)', () => {
  it('rewrites only the requested change and records patch history', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const { storylineId, sceneId } = await projectWithScene(store);
    const before = store.getProject(storylineId).storyline.scenes.find((s) => s.id === sceneId)!;
    const originalPrompt = before.prompt;

    const { client: claude, calls } = makeFakeClaude(() => ({
      stop_reason: 'end_turn',
      model: 'fake',
      content: [{ type: 'text', text: samplePatchJson() }],
    }));

    const { patch } = await patchScene(store, claude, storylineId, sceneId, 'make the hero look worried');

    expect(patch.request).toBe('make the hero look worried');
    expect(patch.before).toBe(originalPrompt);
    expect(patch.after).toContain('worried');
    expect(patch.preserved.length).toBeGreaterThan(0);

    const after = store.getProject(storylineId).storyline.scenes.find((s) => s.id === sceneId)!;
    expect(after.prompt).toContain('worried');
    expect(after.patchHistory).toHaveLength(1);
    // The patch went through the directed-edit system prompt.
    expect(calls.some((c) => String(c.params.system).includes('applying a DIRECTED edit'))).toBe(true);
    // Editing invalidated any render.
    expect(store.getProject(storylineId).clips[sceneId].status).toBe('idle');
  });

  it('rejects an empty change request', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const { storylineId, sceneId } = await projectWithScene(store);
    const { client: claude } = makeFakeClaude();
    await expect(patchScene(store, claude, storylineId, sceneId, '   ')).rejects.toThrow(/describe the change/i);
  });

  it('rejects a patch whose prompt exceeds the render limit', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const { storylineId, sceneId } = await projectWithScene(store);
    const tooLong = JSON.stringify({
      new_prompt: 'x'.repeat(2100),
      changed: 'made it very long',
      preserved: [],
      rationale: 'n/a',
    });
    const { client: claude } = makeFakeClaude(() => ({
      stop_reason: 'end_turn',
      model: 'fake',
      content: [{ type: 'text', text: tooLong }],
    }));
    await expect(patchScene(store, claude, storylineId, sceneId, 'ramble on')).rejects.toThrow(/invalid|2048/i);
  });
});
