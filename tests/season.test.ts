import { afterEach, describe, expect, it } from 'vitest';
import { assertRuntime, buildContinuityBlock, extendPlan, generateNextEpisode, planStory } from '../src/services/season';
import { createStorylineProject } from '../src/services/storyline';
import type { Store } from '../src/store/store';
import { makeStore, makeStudioFakeClaude } from './helpers';

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

function freshStore(): Store {
  const { store, cleanup } = makeStore();
  cleanups.push(cleanup);
  return store;
}

function linearStory(store: Store) {
  return store.createStory({
    title: 'Rocket Quest',
    continuity: 'linear',
    bible: '# Bible\nRizzo the raccoon builds rockets.',
    meta: { audienceMin: 5, audienceMax: 8, episodeLengthSec: 60 },
  });
}

describe('runtime options', () => {
  it('accepts the allowed runtimes and rejects others', () => {
    for (const sec of [15, 30, 60, 90, 180, 300]) expect(() => assertRuntime(sec)).not.toThrow();
    expect(() => assertRuntime(45)).toThrow(/must be one of/);
    expect(() => assertRuntime(null)).not.toThrow();
  });
});

describe('season planning', () => {
  it('plans a linear season with numbered, unproduced slots', async () => {
    const store = freshStore();
    const story = linearStory(store);
    const { client, calls } = makeStudioFakeClaude();

    const updated = await planStory(store, client, story.id, { episodeCount: 3 });
    expect(updated.plan).not.toBeNull();
    expect(updated.plan!.episodes.map((e) => e.number)).toEqual([1, 2, 3]);
    expect(updated.plan!.episodes.every((e) => e.episodeId === null)).toBe(true);
    expect(updated.plan!.arcSummary).toContain('rocket');
    // Prompt carried the bible and the requested count.
    const user = (calls[0].params.messages as Array<{ content: string }>)[0].content;
    expect(user).toContain('Rizzo the raccoon');
    expect(user).toContain('exactly 3 episodes');
  });

  it('refuses to plan a random story', async () => {
    const store = freshStore();
    const story = store.createStory({ title: 'R', bible: 'b' }); // random by default
    const { client } = makeStudioFakeClaude();
    await expect(planStory(store, client, story.id, { episodeCount: 3 })).rejects.toThrow(/linear/);
  });

  it('refuses accidental re-planning but allows replace before production', async () => {
    const store = freshStore();
    const story = linearStory(store);
    const { client } = makeStudioFakeClaude();
    await planStory(store, client, story.id, { episodeCount: 3 });
    await expect(planStory(store, client, story.id, { episodeCount: 4 })).rejects.toThrow(/already exists/);
    const replanned = await planStory(store, client, story.id, { episodeCount: 3, replace: true });
    expect(replanned.plan!.episodes).toHaveLength(3);
  });

  it('extends a plan, renumbering from the end', async () => {
    const store = freshStore();
    const story = linearStory(store);
    const { client } = makeStudioFakeClaude();
    await planStory(store, client, story.id, { episodeCount: 3 });
    const extended = await extendPlan(store, client, story.id, { additionalEpisodes: 2 });
    expect(extended.plan!.episodes.map((e) => e.number)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('episode generation', () => {
  it('random: generates a standalone episode avoiding existing ones', async () => {
    const store = freshStore();
    const story = store.createStory({ title: 'Grove Pals', bible: '# Bible\nBobo the monkey.' });
    store.createEpisode(story.id, { title: 'Old Episode', brief: 'banana chase' });
    const { client, calls } = makeStudioFakeClaude();

    const episode = await generateNextEpisode(store, client, story.id, { runtimeSec: 30, guidance: 'pond stories' });
    expect(episode.title).toBe('The Wobbly Launch');
    expect(episode.runtimeSec).toBe(30);
    expect(episode.plannedNumber).toBeNull();

    const user = (calls[0].params.messages as Array<{ content: string }>)[0].content;
    expect(String(calls[0].params.system)).toContain('standalone');
    expect(user).toContain('Old Episode'); // avoid-repetition recap
    expect(user).toContain('pond stories'); // director guidance
    expect(user).toContain('30s'); // runtime
  });

  it('linear: produces the next plan slot with recap and links it', async () => {
    const store = freshStore();
    const story = linearStory(store);
    const { client, calls } = makeStudioFakeClaude();
    await planStory(store, client, story.id, { episodeCount: 3 });

    const ep1 = await generateNextEpisode(store, client, story.id, { runtimeSec: 90 });
    expect(ep1.plannedNumber).toBe(1);
    let plan = store.getStory(story.id).plan!;
    expect(plan.episodes[0].episodeId).toBe(ep1.id);

    const ep2 = await generateNextEpisode(store, client, story.id, {});
    expect(ep2.plannedNumber).toBe(2);
    plan = store.getStory(story.id).plan!;
    expect(plan.episodes[1].episodeId).toBe(ep2.id);

    // ep2's generation prompt carried the arc + recap of ep1 + its plan slot.
    const genCall = calls[calls.length - 1];
    const user = (genCall.params.messages as Array<{ content: string }>)[0].content;
    expect(String(genCall.params.system)).toContain('serialized');
    expect(user).toContain('Season arc');
    expect(user).toContain(ep1.title);
    expect(user).toContain('Episode 2 of 3');
  });

  it('linear: demands a plan first, and an extension when exhausted', async () => {
    const store = freshStore();
    const story = linearStory(store);
    const { client } = makeStudioFakeClaude({ planJson: undefined });
    await expect(generateNextEpisode(store, client, story.id)).rejects.toThrow(/plan the season first/i);

    await planStory(store, client, story.id, { episodeCount: 2 });
    await generateNextEpisode(store, client, story.id);
    await generateNextEpisode(store, client, story.id);
    await expect(generateNextEpisode(store, client, story.id)).rejects.toThrow(/Extend the season plan/i);
  });

  it('rejects invalid runtimes', async () => {
    const store = freshStore();
    const story = store.createStory({ title: 'S', bible: 'b' });
    const { client } = makeStudioFakeClaude();
    await expect(generateNextEpisode(store, client, story.id, { runtimeSec: 42 })).rejects.toThrow(/must be one of/);
  });
});

describe('continuity-aware storyline generation', () => {
  it('random stories get a standalone directive and the episode runtime', async () => {
    const store = freshStore();
    const story = store.createStory({ title: 'S', bible: 'b' });
    const { client, calls } = makeStudioFakeClaude();
    const ep = store.createEpisode(story.id, { title: 'E', brief: 'x', runtimeSec: 90 });
    await createStorylineProject(store, client, story.id, ep.id, {});
    const user = (calls[0].params.messages as Array<{ content: string }>)[0].content;
    expect(user).toContain('Continuity mode: RANDOM');
    expect(user).toContain('fully standalone');
    expect(user).toContain('~90 seconds');
  });

  it('linear stories get arc position, recap, and finale guard', async () => {
    const store = freshStore();
    const story = linearStory(store);
    const { client, calls } = makeStudioFakeClaude();
    await planStory(store, client, story.id, { episodeCount: 3 });
    const ep1 = await generateNextEpisode(store, client, story.id);
    await generateNextEpisode(store, client, story.id);
    const ep2 = store.listEpisodes(story.id)[1];

    await createStorylineProject(store, client, story.id, ep2.id, {});
    const gen = calls[calls.length - 1];
    const user = (gen.params.messages as Array<{ content: string }>)[0].content;
    expect(user).toContain('Continuity mode: LINEAR');
    expect(user).toContain('episode 2 of 3');
    expect(user).toContain('Previously in the series');
    expect(user).toContain(ep1.title);
    expect(user).toContain('do NOT reveal or resolve yet');
  });

  it('the final planned episode is told to deliver the finale', async () => {
    const store = freshStore();
    const story = linearStory(store);
    const { client } = makeStudioFakeClaude();
    await planStory(store, client, story.id, { episodeCount: 2 });
    await generateNextEpisode(store, client, story.id);
    await generateNextEpisode(store, client, story.id);
    const finaleEp = store.listEpisodes(story.id)[1];
    const block = buildContinuityBlock(store, store.getStory(story.id), finaleEp);
    expect(block).toContain('This is the season finale');
  });
});
