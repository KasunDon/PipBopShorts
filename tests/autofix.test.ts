import { afterEach, describe, expect, it } from 'vitest';
import { autofixStoryline } from '../src/services/autofix';
import { createStorylineProject, updateScene } from '../src/services/storyline';
import type { Store } from '../src/store/store';
import { makeFakeClaude, makeStore, sampleAutofixJson } from './helpers';

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

/** A storyline whose first scene is broken: fast motion at 8s (an invalid combo). */
async function brokenStoryline(store: Store) {
  const story = store.createStory({
    title: 'Fixable',
    bible: '# Bible\nA hero races through a neon city.',
    meta: { audienceMin: 13, audienceMax: 18, tones: ['energetic'] },
  });
  const episode = store.createEpisode(story.id, { title: 'E1', brief: 'chase' });
  const { client: claude } = makeFakeClaude();
  const project = await createStorylineProject(store, claude, story.id, episode.id, {});
  // Force scene 1 into an invalid state directly on the store (bypasses updateScene's guard).
  const stored = store.getProject(project.storyline.id);
  const scene = stored.storyline.scenes[0];
  scene.motionMode = 'fast';
  scene.duration = 8;
  store.saveProject(stored);
  return { story, storylineId: project.storyline.id, sceneId: scene.id };
}

describe('autofixStoryline', () => {
  it('uses the LLM proposal to fix a scene while preserving creative intent (prompt untouched)', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const { storylineId, sceneId } = await brokenStoryline(store);
    const before = store.getProject(storylineId).storyline.scenes.find((s) => s.id === sceneId)!;
    const originalPrompt = before.prompt;

    const { client: claude, calls } = makeFakeClaude(() => ({
      stop_reason: 'end_turn',
      model: 'fake',
      content: [{ type: 'text', text: sampleAutofixJson() }],
    }));

    const result = await autofixStoryline(store, claude, storylineId);

    expect(result.ok).toBe(true);
    expect(result.fixedCount).toBe(1);
    const fix = result.fixes[0];
    expect(fix.method).toBe('llm');
    expect(fix.resolved).toBe(true);
    expect(fix.changes.join(' ')).toContain('duration 8→5');

    const after = store.getProject(storylineId).storyline.scenes.find((s) => s.id === sceneId)!;
    // LLM kept the fast-motion energy, just shortened the clip; the prompt is unchanged.
    expect(after.motionMode).toBe('fast');
    expect(after.duration).toBe(5);
    expect(after.prompt).toBe(originalPrompt);
    // An autofix call was actually made.
    expect(calls.some((c) => String(c.params.system).includes('technical delivery supervisor'))).toBe(true);
  });

  it('never applies an LLM fix that would still be invalid — falls back to a safe default', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const { storylineId, sceneId } = await brokenStoryline(store);

    // The LLM returns a still-invalid combo (fast + 8s again).
    const badFix = JSON.stringify({
      fixes: [
        {
          scene_number: 1,
          duration: 8,
          quality: '540p',
          motion_mode: 'fast',
          model: 'v5',
          aspect_ratio: '9:16',
          style: 'none',
          camera_movement: 'none',
          rationale: 'still broken',
        },
      ],
    });
    const { client: claude } = makeFakeClaude(() => ({
      stop_reason: 'end_turn',
      model: 'fake',
      content: [{ type: 'text', text: badFix }],
    }));

    const result = await autofixStoryline(store, claude, storylineId);
    expect(result.ok).toBe(true);
    expect(result.fixes[0].method).toBe('deterministic');
    const after = store.getProject(storylineId).storyline.scenes.find((s) => s.id === sceneId)!;
    // Deterministic fallback shortens to 5s.
    expect(after.duration).toBe(5);
    // The result must actually be valid.
    expect(() => updateScene(store, storylineId, sceneId, {})).not.toThrow();
  });

  it('still fixes everything when the LLM call throws entirely', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const { storylineId, sceneId } = await brokenStoryline(store);
    const { client: claude } = makeFakeClaude(() => {
      throw new Error('gateway down');
    });

    const result = await autofixStoryline(store, claude, storylineId);
    expect(result.ok).toBe(true);
    expect(result.model).toBeNull();
    expect(result.fixes[0].method).toBe('deterministic');
    const after = store.getProject(storylineId).storyline.scenes.find((s) => s.id === sceneId)!;
    expect(after.duration).toBe(5);
  });

  it('is a no-op when every scene already passes validation', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const story = store.createStory({ title: 'Clean', bible: '# Bible\nHero.' });
    const episode = store.createEpisode(story.id, { title: 'E1', brief: 'x' });
    const { client: claude } = makeFakeClaude();
    const project = await createStorylineProject(store, claude, story.id, episode.id, {});

    const result = await autofixStoryline(store, claude, project.storyline.id);
    expect(result.ok).toBe(true);
    expect(result.scenesConsidered).toBe(0);
    expect(result.fixedCount).toBe(0);
    expect(result.fixes).toHaveLength(0);
  });
});
