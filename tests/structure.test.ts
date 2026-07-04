import { afterEach, describe, expect, it } from 'vitest';
import { validateStorylineForRender } from '../src/services/preview';
import { createStorylineProject, fixSceneRenderCombo } from '../src/services/storyline';
import { makeFakeClaude, makeStore } from './helpers';

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

describe('generation-time render-param normalization', () => {
  it('shortens fast-motion / 1080p 8s combos to 5s in place', () => {
    const fast = { quality: '540p', duration: 8, motionMode: 'fast' };
    expect(fixSceneRenderCombo(fast)).toBe(true);
    expect(fast.duration).toBe(5);
    const hd = { quality: '1080p', duration: 8, motionMode: 'normal' };
    expect(fixSceneRenderCombo(hd)).toBe(true);
    expect(hd.duration).toBe(5);
    const ok = { quality: '540p', duration: 8, motionMode: 'normal' };
    expect(fixSceneRenderCombo(ok)).toBe(false);
  });

  it('a generated storyline with an invalid combo is valid out of the box', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const story = store.createStory({ title: 'Fixup', bible: '# Bible\nHero.' });
    const episode = store.createEpisode(story.id, { title: 'E1', brief: 'x' });
    // Force the LLM to emit an invalid combo: fast motion at 8s.
    const bad = JSON.stringify({
      title: 'T',
      logline: 'L',
      scenes: [
        {
          heading: 'S1',
          description: 'd',
          prompt: 'a vivid shot',
          negative_prompt: 'blurry',
          duration: 8,
          aspect_ratio: '9:16',
          model: 'v5',
          quality: '540p',
          motion_mode: 'fast',
          style: 'none',
          camera_movement: 'none',
        },
      ],
      youtube: { title: 'T', description: 'd', tags: ['a'], hashtags: ['#Shorts'] },
    });
    const { client } = makeFakeClaude(() => ({ stop_reason: 'end_turn', model: 'fake', content: [{ type: 'text', text: bad }] }));
    const project = await createStorylineProject(store, client, story.id, episode.id, {});
    expect(project.storyline.scenes[0].duration).toBe(5); // normalized
    expect(validateStorylineForRender(store, project.storyline.id).ok).toBe(true);
  });
});

describe('storyline narrative structure', () => {
  it('injects a three-act directive into the generation prompt when requested', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const story = store.createStory({ title: 'Arc', bible: '# Bible\nHero in a neon city.' });
    const episode = store.createEpisode(story.id, { title: 'E1', brief: 'x' });
    const { client, calls } = makeFakeClaude();

    await createStorylineProject(store, client, story.id, episode.id, { structure: 'three-act' });

    const gen = calls.find((c) => Array.isArray(c.params.messages));
    const userMsg = String((gen!.params.messages as Array<{ content: string }>)[0].content);
    expect(userMsg).toContain('THREE-ACT');
  });

  it('injects a parallel-threads directive when requested', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const story = store.createStory({ title: 'Weave', bible: '# Bible\nHero and a friend.' });
    const episode = store.createEpisode(story.id, { title: 'E1', brief: 'x' });
    const { client, calls } = makeFakeClaude();
    await createStorylineProject(store, client, story.id, episode.id, { structure: 'parallel' });
    const gen = calls.find((c) => Array.isArray(c.params.messages));
    const userMsg = String((gen!.params.messages as Array<{ content: string }>)[0].content);
    expect(userMsg).toContain('PARALLEL THREADS');
  });

  it('omits the directive for a single-thread storyline', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const story = store.createStory({ title: 'Plain', bible: '# Bible\nHero.' });
    const episode = store.createEpisode(story.id, { title: 'E1', brief: 'x' });
    const { client, calls } = makeFakeClaude();

    await createStorylineProject(store, client, story.id, episode.id, {});
    const gen = calls.find((c) => Array.isArray(c.params.messages));
    const userMsg = String((gen!.params.messages as Array<{ content: string }>)[0].content);
    expect(userMsg).not.toContain('THREE-ACT');
  });
});
