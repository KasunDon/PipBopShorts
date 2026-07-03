import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NotFoundError, Store, slugify } from '../src/store/store';
import { makeStore } from './helpers';

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});
function freshStore(): { store: Store; dir: string } {
  const { store, dir, cleanup } = makeStore();
  cleanups.push(cleanup);
  return { store, dir };
}

describe('slugify', () => {
  it('normalizes titles', () => {
    expect(slugify('Neon Nights: Episode 1!')).toBe('neon-nights-episode-1');
  });
  it('falls back for empty input', () => {
    expect(slugify('!!!')).toBe('story');
  });
});

describe('stories', () => {
  it('creates a story and writes a bible.md file', () => {
    const { store, dir } = freshStore();
    const story = store.createStory({ title: 'My Story', bible: '# Hello world' });
    expect(story.id).toBeTruthy();
    expect(story.slug).toBe('my-story');
    const biblePath = path.join(dir, 'stories', story.id, 'bible.md');
    expect(fs.existsSync(biblePath)).toBe(true);
    expect(store.getBible(story.id)).toBe('# Hello world');
  });

  it('creates a default bible from the story template when none supplied', () => {
    const { store } = freshStore();
    const story = store.createStory({ title: 'Defaults' });
    const bible = store.getBible(story.id);
    expect(bible).toContain('Defaults — Story Bible');
    expect(bible).toContain('Main Characters');
    expect(bible).toContain('Never change');
    expect(bible).toContain('Consistency Prompt Reference');
  });

  it('updates and reads the bible from disk', () => {
    const { store } = freshStore();
    const story = store.createStory({ title: 'Editable' });
    store.setBible(story.id, '# Updated bible');
    expect(store.getBible(story.id)).toBe('# Updated bible');
  });

  it('persists across store instances', () => {
    const { store, dir } = freshStore();
    const story = store.createStory({ title: 'Persisted' });
    const reopened = new Store(dir);
    expect(reopened.getStory(story.id).title).toBe('Persisted');
    expect(reopened.getBible(story.id)).toBeTruthy();
  });

  it('throws NotFoundError for missing stories', () => {
    const { store } = freshStore();
    expect(() => store.getStory('nope')).toThrow(NotFoundError);
  });

  it('deletes a story and its files', () => {
    const { store, dir } = freshStore();
    const story = store.createStory({ title: 'Doomed' });
    store.deleteStory(story.id);
    expect(fs.existsSync(path.join(dir, 'stories', story.id))).toBe(false);
    expect(() => store.getStory(story.id)).toThrow(NotFoundError);
  });
});

describe('episodes', () => {
  it('creates episodes and lists them by story', () => {
    const { store } = freshStore();
    const story = store.createStory({ title: 'S' });
    const a = store.createEpisode(story.id, { title: 'Ep A', brief: 'brief a' });
    const b = store.createEpisode(story.id, { title: 'Ep B' });
    const list = store.listEpisodes(story.id);
    expect(list.map((e) => e.id)).toEqual([a.id, b.id]);
    expect(store.getEpisode(a.id).brief).toBe('brief a');
  });

  it('stores a per-episode setting override as a .md file', () => {
    const { store, dir } = freshStore();
    const story = store.createStory({ title: 'S', settingMode: 'per-episode' });
    const ep = store.createEpisode(story.id, { title: 'Ep', setting: '# Frozen moon' });
    expect(ep.hasSettingOverride).toBe(true);
    const settingPath = path.join(dir, 'stories', story.id, 'episodes', ep.id, 'setting.md');
    expect(fs.existsSync(settingPath)).toBe(true);
    expect(store.getSetting(ep.id)).toBe('# Frozen moon');
  });

  it('sets a setting after creation', () => {
    const { store } = freshStore();
    const story = store.createStory({ title: 'S', settingMode: 'per-episode' });
    const ep = store.createEpisode(story.id, { title: 'Ep' });
    expect(ep.hasSettingOverride).toBe(false);
    store.setSetting(ep.id, '# Later setting');
    expect(store.getEpisode(ep.id).hasSettingOverride).toBe(true);
    expect(store.getSetting(ep.id)).toBe('# Later setting');
  });

  it('deleting a story deletes its episodes', () => {
    const { store } = freshStore();
    const story = store.createStory({ title: 'S' });
    const ep = store.createEpisode(story.id, { title: 'Ep' });
    store.deleteStory(story.id);
    expect(() => store.getEpisode(ep.id)).toThrow(NotFoundError);
  });
});
