import { afterEach, describe, expect, it } from 'vitest';
import { extractCanon } from '../src/services/canon';
import { createStorylineProject } from '../src/services/storyline';
import { makeStore, makeStudioFakeClaude } from './helpers';

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

describe('store: stories and episodes', () => {
  it('creates a story with a slug and a bible, and reads them back', () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const story = store.createStory({ title: 'My Great Show', bible: '# Bible\nA hero.' });
    expect(store.getStory(story.id).slug).toBe('my-great-show');
    expect(store.getBible(story.id)).toContain('A hero.');
  });

  it('deleting a story removes its episodes and projects too', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const { client } = makeStudioFakeClaude();
    const story = store.createStory({ title: 'Doomed', bible: '# Bible\nx' });
    const episode = store.createEpisode(story.id, { title: 'E1', brief: 'b' });
    const project = await createStorylineProject(store, client, story.id, episode.id, {});

    store.deleteStory(story.id);

    expect(() => store.getStory(story.id)).toThrow();
    expect(() => store.getEpisode(episode.id)).toThrow();
    expect(() => store.getProject(project.storyline.id)).toThrow();
  });
});

describe('store: lossless snapshot/restore (the fail-safe behind audit restore)', () => {
  it('round-trips a whole story subtree — canon, characters, episodes, storylines', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const { client } = makeStudioFakeClaude();
    const story = store.createStory({ title: 'Round Trip', bible: '# Bible\nBobo has a green scarf.' });
    await extractCanon(store, client, story.id);
    const episode = store.createEpisode(story.id, { title: 'E1', brief: 'b' });
    const project = await createStorylineProject(store, client, story.id, episode.id, {});

    const snapshot = store.snapshotStory(story.id);
    store.deleteStory(story.id);
    store.restoreStorySnapshot(snapshot);

    expect(store.getStory(story.id).title).toBe('Round Trip');
    expect(store.getCanonRegistry(story.id)?.currentVersion).toBe(1);
    expect(store.getEpisode(episode.id).title).toBe('E1');
    expect(store.getProject(project.storyline.id).storyline.id).toBe(project.storyline.id);
  });

  it('refuses to restore a story that still exists', () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const story = store.createStory({ title: 'Live', bible: '# Bible' });
    const snapshot = store.snapshotStory(story.id);
    expect(() => store.restoreStorySnapshot(snapshot)).toThrow();
  });
});
