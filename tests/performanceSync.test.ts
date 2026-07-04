import { afterEach, describe, expect, it } from 'vitest';
import type { AnalyticsSource } from '../src/clients/youtube';
import { generateClip, setClipApproval } from '../src/services/generation';
import { syncPerformance } from '../src/services/performanceSync';
import { publishProject } from '../src/services/publish';
import { createStorylineProject } from '../src/services/storyline';
import type { Store } from '../src/store/store';
import { makeDryRunYoutube, makeFakeClaude, makeFakePixverse, makeStore, noSleep } from './helpers';

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

async function publishedStory(store: Store) {
  const story = store.createStory({ title: 'Sync', bible: '# Bible\nHero.' });
  const episode = store.createEpisode(story.id, { title: 'E1', brief: 'x' });
  const { client: claude } = makeFakeClaude();
  const project = await createStorylineProject(store, claude, story.id, episode.id, {});
  const { client: pixverse } = makeFakePixverse({ defaultStatus: 1 });
  for (const scene of project.storyline.scenes) {
    await generateClip(store, pixverse, project.storyline.id, scene.id, { wait: true, pollIntervalMs: 1, sleep: noSleep });
    setClipApproval(store, project.storyline.id, scene.id, true);
  }
  await publishProject(store, makeDryRunYoutube(), project.storyline.id, { requireApproval: true });
  return { story, storylineId: project.storyline.id };
}

describe('performance sync', () => {
  it('records analytics onto published storylines from the source', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const { story, storylineId } = await publishedStory(store);

    const source: AnalyticsSource = {
      async fetchAnalytics() {
        return { views: 8800, likes: 210, avgViewPct: 58 };
      },
    };
    const result = await syncPerformance(store, source, story.id);
    expect(result.updated).toBe(1);
    expect(store.getProject(storylineId).performance?.views).toBe(8800);
    expect(store.getProject(storylineId).performance?.retentionPct).toBe(58);
  });

  it('no-ops when the source has no analytics (unconfigured)', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const { story, storylineId } = await publishedStory(store);

    const source: AnalyticsSource = { async fetchAnalytics() { return null; } };
    const result = await syncPerformance(store, source, story.id);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(store.getProject(storylineId).performance ?? null).toBeNull();
  });
});
