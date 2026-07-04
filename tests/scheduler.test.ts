import { afterEach, describe, expect, it } from 'vitest';
import { generateClip, setClipApproval } from '../src/services/generation';
import {
  PublishScheduler,
  cancelRenderSchedule,
  cancelSchedule,
  schedulePublish,
  scheduleRender,
} from '../src/services/scheduler';
import { createStorylineProject } from '../src/services/storyline';
import type { Store } from '../src/store/store';
import { makeDryRunYoutube, makeFakeClaude, makeFakePixverse, makeStore, noSleep } from './helpers';

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

async function renderedApprovedProject(store: Store) {
  const story = store.createStory({ title: 'Sched', bible: '# Bible\nHero.' });
  const episode = store.createEpisode(story.id, { title: 'E1', brief: 'x' });
  const { client: claude } = makeFakeClaude();
  const project = await createStorylineProject(store, claude, story.id, episode.id, {});
  const { client: pixverse } = makeFakePixverse({ defaultStatus: 1 });
  for (const scene of project.storyline.scenes) {
    await generateClip(store, pixverse, project.storyline.id, scene.id, { wait: true, pollIntervalMs: 1, sleep: noSleep });
    setClipApproval(store, project.storyline.id, scene.id, true);
  }
  return project.storyline.id;
}

describe('publish scheduling', () => {
  it('fires a due schedule and skips a not-yet-due one', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const storylineId = await renderedApprovedProject(store);

    const now = new Date('2026-07-04T10:00:00Z');
    schedulePublish(store, storylineId, { at: '2026-07-04T12:00:00Z', privacyStatus: 'unlisted' }, now);

    const scheduler = new PublishScheduler({ store, youtube: makeDryRunYoutube() });

    // Before the scheduled time: nothing fires.
    expect(await scheduler.tick(new Date('2026-07-04T11:00:00Z'))).toBe(0);
    expect(store.getProject(storylineId).schedule?.status).toBe('pending');

    // At/after the time: it publishes.
    expect(await scheduler.tick(new Date('2026-07-04T12:00:01Z'))).toBe(1);
    const project = store.getProject(storylineId);
    expect(project.schedule?.status).toBe('published');
    expect(project.publish?.status).toBe('published');

    // A second tick does not re-fire it.
    expect(await scheduler.tick(new Date('2026-07-04T13:00:00Z'))).toBe(0);
  });

  it('records a failure (not a publish) when clips are not approved at fire time', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const story = store.createStory({ title: 'Unapproved', bible: '# Bible\nHero.' });
    const episode = store.createEpisode(story.id, { title: 'E1', brief: 'x' });
    const { client: claude } = makeFakeClaude();
    const project = await createStorylineProject(store, claude, story.id, episode.id, {});
    const { client: pixverse } = makeFakePixverse({ defaultStatus: 1 });
    const sceneId = project.storyline.scenes[0].id;
    await generateClip(store, pixverse, project.storyline.id, sceneId, { wait: true, pollIntervalMs: 1, sleep: noSleep });
    // NOT approved.

    const now = new Date('2026-07-04T10:00:00Z');
    schedulePublish(store, project.storyline.id, { at: '2026-07-04T12:00:00Z' }, now);
    const scheduler = new PublishScheduler({ store, youtube: makeDryRunYoutube() });
    expect(await scheduler.tick(new Date('2026-07-04T12:00:01Z'))).toBe(1);
    const after = store.getProject(project.storyline.id);
    expect(after.schedule?.status).toBe('failed');
    expect(after.schedule?.error).toMatch(/approve/i);
  });

  it('fires a due render run and submits clips to the runner callback', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const story = store.createStory({ title: 'Rndr', bible: '# Bible\nHero.' });
    const episode = store.createEpisode(story.id, { title: 'E1', brief: 'x' });
    const { client: claude } = makeFakeClaude();
    const project = await createStorylineProject(store, claude, story.id, episode.id, {});
    const storylineId = project.storyline.id;

    // Async submit: clip becomes generating with a videoId, then completes on poll.
    const { client: pixverse } = makeFakePixverse({ resultSequences: { 111: [5, 1], 222: [5, 1] } });
    const submitted: string[] = [];
    const scheduler = new PublishScheduler({
      store,
      youtube: makeDryRunYoutube(),
      pixverse,
      generateDefaults: { pollIntervalMs: 1, sleep: noSleep },
      onClipSubmitted: (_sid, clip) => submitted.push(clip.sceneId),
    });

    const now = new Date('2026-07-04T10:00:00Z');
    scheduleRender(store, storylineId, '2026-07-04T12:00:00Z', now);
    expect(await scheduler.tick(new Date('2026-07-04T11:00:00Z'))).toBe(0); // not due
    expect(await scheduler.tick(new Date('2026-07-04T12:00:01Z'))).toBe(1); // fires

    expect(store.getProject(storylineId).renderSchedule?.status).toBe('started');
    expect(submitted.length).toBeGreaterThan(0);
    // Does not re-fire.
    expect(await scheduler.tick(new Date('2026-07-04T13:00:00Z'))).toBe(0);
  });

  it('cancels a pending render schedule', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const storylineId = await renderedApprovedProject(store);
    scheduleRender(store, storylineId, '2026-07-04T12:00:00Z', new Date('2026-07-04T10:00:00Z'));
    const project = cancelRenderSchedule(store, storylineId);
    expect(project.renderSchedule?.status).toBe('cancelled');
    expect(() => cancelRenderSchedule(store, storylineId)).toThrow(/no pending/i);
  });

  it('rejects a past schedule time and cancels a pending one', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const storylineId = await renderedApprovedProject(store);
    const now = new Date('2026-07-04T10:00:00Z');
    expect(() => schedulePublish(store, storylineId, { at: '2020-01-01T00:00:00Z' }, now)).toThrow(/future/i);

    schedulePublish(store, storylineId, { at: '2026-07-04T12:00:00Z' }, now);
    const project = cancelSchedule(store, storylineId);
    expect(project.schedule?.status).toBe('cancelled');
    expect(() => cancelSchedule(store, storylineId)).toThrow(/no pending/i);
  });
});
