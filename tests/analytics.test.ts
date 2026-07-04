import { afterEach, describe, expect, it } from 'vitest';
import { storyAnalytics } from '../src/services/analytics';
import { extractCanon } from '../src/services/canon';
import { checkDrift } from '../src/services/drift';
import { generateClip, setClipApproval } from '../src/services/generation';
import { createStorylineProject } from '../src/services/storyline';
import { makeFakePixverse, makeStore, makeStudioFakeClaude, noSleep } from './helpers';

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

describe('storyAnalytics', () => {
  it('aggregates volume, approval, canon stability, and drift health', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const story = store.createStory({
      title: 'Analytics Show',
      bible: '# Bible\nBobo wears a bright green leaf scarf.',
      meta: { audienceMin: 4, audienceMax: 7 },
    });
    const { client } = makeStudioFakeClaude();
    await extractCanon(store, client, story.id);
    const episode = store.createEpisode(story.id, { title: 'E1', brief: 'banana quest' });
    const project = await createStorylineProject(store, client, story.id, episode.id, {});
    const sceneId = project.storyline.scenes[0].id;

    // Render + approve one clip.
    const { client: pixverse } = makeFakePixverse({ defaultStatus: 1 });
    await generateClip(store, pixverse, project.storyline.id, sceneId, { wait: true, pollIntervalMs: 1, sleep: noSleep });
    setClipApproval(store, project.storyline.id, sceneId, true);

    // A drift report (sample has 2 findings, one is consistency high).
    await checkDrift(store, client, project.storyline.id);

    const a = storyAnalytics(store, story.id);
    expect(a.episodes).toBe(1);
    expect(a.storylines).toBe(1);
    expect(a.scenes).toBe(project.storyline.scenes.length);
    expect(a.clips.ready).toBe(1);
    expect(a.clips.approved).toBe(1);
    expect(a.canon.versions).toBe(1);
    expect(a.canon.marks).toBeGreaterThan(0);
    expect(a.canon.lockedMarks).toBeGreaterThan(0);
    expect(a.drift.reports).toBe(1);
    expect(a.drift.findings).toBeGreaterThan(0);
    expect(a.drift.open).toBe(a.drift.findings); // none resolved yet
    expect(a.drift.driftRate).toBeGreaterThan(0);
  });

  it('is all-zero for a fresh story with no production', () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const story = store.createStory({ title: 'Empty', bible: '# Bible' });
    const a = storyAnalytics(store, story.id);
    expect(a.episodes).toBe(0);
    expect(a.storylines).toBe(0);
    expect(a.scenes).toBe(0);
    expect(a.clips.total).toBe(0);
    expect(a.canon.versions).toBe(0);
    expect(a.drift.driftRate).toBe(0);
  });
});
