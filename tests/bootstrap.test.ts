import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapStory, draftEpisode } from '../src/services/bootstrap';
import { makeStore, makeStudioFakeClaude } from './helpers';

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

function freshStore() {
  const { store, cleanup } = makeStore();
  cleanups.push(cleanup);
  return store;
}

describe('bootstrapStory', () => {
  it('creates a story with LLM-populated title, metadata, and bible', async () => {
    const store = freshStore();
    const { client, calls } = makeStudioFakeClaude();

    const { story, registry } = await bootstrapStory(store, client, {
      idea: 'two raccoon siblings run a junkyard space program for kids',
      withCanon: false,
    });

    expect(story.title).toBe('Rocket Raccoons');
    expect(story.settingMode).toBe('shared');
    expect(story.meta.audienceMin).toBe(5);
    expect(story.meta.audienceMax).toBe(8);
    expect(story.meta.genres).toEqual(['comedy', 'sci-fi']);
    expect(story.meta.tones).toContain('cheerful');
    expect(store.getBible(story.id)).toContain('Rocket Raccoons — Story Bible');
    expect(store.getBible(story.id)).toContain('Never change');
    expect(registry).toBeNull();

    // The prompt carried the idea and the reference template structure.
    const user = (calls[0].params.messages as Array<{ content: string }>)[0].content;
    expect(user).toContain('junkyard space program');
    expect(user).toContain('Consistency Prompt Reference');
    expect(calls[0].params.model).toBe('claude-sonnet-5'); // default
  });

  it('optionally extracts canon in the same flow', async () => {
    const store = freshStore();
    const { client, calls } = makeStudioFakeClaude();
    const { story, registry } = await bootstrapStory(store, client, {
      idea: 'space raccoons',
      withCanon: true,
      model: 'claude-opus-4-8',
    });
    expect(registry).not.toBeNull();
    expect(registry!.currentVersion).toBe(1);
    expect(store.getCanonRegistry(story.id)).not.toBeNull();
    // Both calls used the chosen model.
    expect(calls.map((c) => c.params.model)).toEqual(['claude-opus-4-8', 'claude-opus-4-8']);
    // Metadata-derived audience marks came along automatically.
    const aud = registry!.versions[0].entities.find((e) => e.type === 'audience_tone');
    expect(aud?.marks.some((m) => m.key === 'target_audience' && m.value.includes('5–8'))).toBe(true);
  });

  it('requires an idea', async () => {
    const store = freshStore();
    const { client } = makeStudioFakeClaude();
    await expect(bootstrapStory(store, client, { idea: '   ' })).rejects.toThrow(/idea is required/i);
  });
});

describe('draftEpisode', () => {
  it('drafts title/brief from the idea and bible without persisting anything', async () => {
    const store = freshStore();
    const { client, calls } = makeStudioFakeClaude();
    const story = store.createStory({ title: 'S', bible: '# Bible\nRizzo the raccoon.' });

    const draft = await draftEpisode(store, client, story.id, 'a wobbly rocket launch');
    expect(draft.title).toBe('The Wobbly Launch');
    expect(draft.brief).toContain('bottle rocket');
    expect(draft.setting).toBe(''); // shared mode strips the setting
    expect(store.listEpisodes(story.id)).toHaveLength(0); // nothing persisted

    const user = (calls[0].params.messages as Array<{ content: string }>)[0].content;
    expect(user).toContain('a wobbly rocket launch');
    expect(user).toContain('Rizzo the raccoon');
  });

  it('keeps the drafted setting for per-episode stories', async () => {
    const store = freshStore();
    const { client } = makeStudioFakeClaude();
    const story = store.createStory({ title: 'S', settingMode: 'per-episode', bible: 'b' });
    const draft = await draftEpisode(store, client, story.id, 'launch day');
    expect(draft.setting).toContain('Junkyard launchpad');
  });
});
