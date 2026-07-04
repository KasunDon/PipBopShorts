import { afterEach, describe, expect, it } from 'vitest';
import { createStorylineProject } from '../src/services/storyline';
import { makeFakeClaude, makeStore } from './helpers';

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
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
