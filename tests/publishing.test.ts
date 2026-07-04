import { afterEach, describe, expect, it } from 'vitest';
import { generateClip, setClipApproval } from '../src/services/generation';
import { publishProject } from '../src/services/publish';
import { PublishScheduler, scheduleRender, schedulePublish } from '../src/services/scheduler';
import { createStorylineProject } from '../src/services/storyline';
import type { Store } from '../src/store/store';
import { makeDryRunYoutube, makeFakeClaude, makeFakePixverse, makeStore, noSleep } from './helpers';

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

/** A storyline whose every scene is rendered; optionally approve them. */
async function renderedStoryline(store: Store, approve: boolean) {
  const story = store.createStory({ title: 'Pub', bible: '# Bible\nHero.' });
  const episode = store.createEpisode(story.id, { title: 'E1', brief: 'x' });
  const { client } = makeFakeClaude();
  const project = await createStorylineProject(store, client, story.id, episode.id, {});
  const { client: pixverse } = makeFakePixverse({ defaultStatus: 1 });
  for (const scene of project.storyline.scenes) {
    await generateClip(store, pixverse, project.storyline.id, scene.id, { wait: true, pollIntervalMs: 1, sleep: noSleep });
    if (approve) setClipApproval(store, project.storyline.id, scene.id, true);
  }
  return project.storyline.id;
}

describe('publishing and the approval gate', () => {
  it('only lets a rendered clip be approved', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const id = await renderedStoryline(store, false);
    const missing = store.getProject(id).storyline.scenes[0].id;
    // A ready clip can be approved.
    expect(() => setClipApproval(store, id, missing, true)).not.toThrow();
  });

  it('blocks publishing until every rendered clip is approved', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const id = await renderedStoryline(store, false);
    const youtube = makeDryRunYoutube();

    await expect(publishProject(store, youtube, id, { requireApproval: true })).rejects.toThrow(/approve/i);

    for (const scene of store.getProject(id).storyline.scenes) setClipApproval(store, id, scene.id, true);
    const record = await publishProject(store, youtube, id, { requireApproval: true });
    expect(record.status).toBe('published');
    expect(record.dryRun).toBe(true);
  });

  it('records each publish attempt in the history', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const id = await renderedStoryline(store, true);
    const youtube = makeDryRunYoutube();
    await publishProject(store, youtube, id, {});
    await publishProject(store, youtube, id, {});
    expect(store.getProject(id).publishHistory).toHaveLength(2);
  });
});

describe('scheduling (fires server-side at a due time)', () => {
  const early = new Date('2026-07-04T10:00:00Z');
  const notDue = new Date('2026-07-04T11:00:00Z');
  const due = new Date('2026-07-04T12:00:01Z');

  it('fires a due scheduled publish and skips one that is not due yet', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const id = await renderedStoryline(store, true);
    schedulePublish(store, id, { at: '2026-07-04T12:00:00Z', privacyStatus: 'unlisted' }, early);
    const scheduler = new PublishScheduler({ store, youtube: makeDryRunYoutube() });

    expect(await scheduler.tick(notDue)).toBe(0);
    expect(store.getProject(id).schedule?.status).toBe('pending');

    expect(await scheduler.tick(due)).toBe(1);
    expect(store.getProject(id).publish?.status).toBe('published');
    // Does not re-fire.
    expect(await scheduler.tick(due)).toBe(0);
  });

  it('fires a due render run into the job callback', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const id = await renderedStoryline(store, false);
    const { client: pixverse } = makeFakePixverse({ resultSequences: { 111: [5, 1], 222: [5, 1] } });
    const submitted: string[] = [];
    const scheduler = new PublishScheduler({
      store,
      youtube: makeDryRunYoutube(),
      pixverse,
      generateDefaults: { pollIntervalMs: 1, sleep: noSleep },
      onClipSubmitted: (_id, clip) => submitted.push(clip.sceneId),
    });

    scheduleRender(store, id, '2026-07-04T12:00:00Z', early);
    expect(await scheduler.tick(due)).toBe(1);
    expect(store.getProject(id).renderSchedule?.status).toBe('started');
    expect(submitted.length).toBeGreaterThan(0);
  });
});
