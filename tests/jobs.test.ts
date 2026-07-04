import http from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp, type AppDeps } from '../src/app';
import { extractCanon } from '../src/services/canon';
import { generatePortrait } from '../src/services/characters';
import { generateClip } from '../src/services/generation';
import { JobRunner, type JobEvent } from '../src/services/jobs';
import { createStorylineProject } from '../src/services/storyline';
import type { Store } from '../src/store/store';
import { makeDryRunYoutube, makeFakeClaude, makeFakePixverse, makeStore, makeStudioFakeClaude, noSleep } from './helpers';

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

async function projectWithScene(store: Store) {
  const story = store.createStory({ title: 'Async Story', bible: '# Bible\nHero cat.' });
  const episode = store.createEpisode(story.id, { title: 'E1', brief: 'x' });
  const { client: claude } = makeFakeClaude();
  const project = await createStorylineProject(store, claude, story.id, episode.id, {});
  return { story, project, sceneId: project.storyline.scenes[0].id };
}

describe('JobRunner', () => {
  it('completes a clip render across ticks and emits done (server-side, no browser needed)', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const { project, sceneId } = await projectWithScene(store);
    // PixVerse reports "generating" once, then success.
    const { client: pixverse } = makeFakePixverse({ resultSequences: { 111: [5, 1] } });

    // Async submit: returns immediately with a generating clip + videoId.
    const clip = await generateClip(store, pixverse, project.storyline.id, sceneId, { wait: false });
    expect(clip.status).toBe('generating');
    expect(clip.videoId).toBe(111);

    const runner = new JobRunner({ store, pixverse });
    const events: JobEvent[] = [];
    runner.subscribe((e) => events.push(e));
    runner.track({ kind: 'clip', storylineId: project.storyline.id, sceneId });
    expect(runner.pending()).toHaveLength(1);
    expect(events[0].type).toBe('queued');
    expect(events[0].job.label).toContain('Scene 1');

    await runner.tick(); // still generating
    expect(runner.pending()).toHaveLength(1);
    await runner.tick(); // success
    expect(runner.pending()).toHaveLength(0);

    const done = events.find((e) => e.type === 'done')!;
    expect(done.status).toBe('ready');
    expect(done.url).toContain('.mp4');
    // The store was updated by the runner — no client involved.
    expect(store.getProject(project.storyline.id).clips[sceneId].status).toBe('ready');
  });

  it('completes a portrait render and dedupes double-tracking', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const story = store.createStory({
      title: 'Pals',
      bible: '# Bible\nBobo is a golden-brown monkey with a bright green leaf scarf.',
      meta: { audienceMin: 4, audienceMax: 7 },
    });
    const { client: studio } = makeStudioFakeClaude();
    await extractCanon(store, studio, story.id);
    const { client: pixverse } = makeFakePixverse({ resultSequences: { 111: [5, 1] } });

    const version = await generatePortrait(store, pixverse, story.id, 'CHAR_BOBO_001', { wait: false });
    expect(version.status).toBe('generating');

    const runner = new JobRunner({ store, pixverse });
    const ref = { kind: 'portrait', storyId: story.id, entityId: 'CHAR_BOBO_001', versionId: version.id } as const;
    runner.track(ref);
    runner.track(ref); // dedupe
    expect(runner.pending()).toHaveLength(1);

    await runner.tick();
    await runner.tick();
    expect(runner.pending()).toHaveLength(0);
    const registry = store.getCharacterRegistry(story.id)!;
    expect(registry.characters['CHAR_BOBO_001'].versions.find((v) => v.id === version.id)?.status).toBe('ready');
  });

  it('resume() re-tracks in-flight renders after a restart', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const { project, sceneId } = await projectWithScene(store);
    const { client: pixverse } = makeFakePixverse({ resultSequences: { 111: [5, 1] } });
    await generateClip(store, pixverse, project.storyline.id, sceneId, { wait: false });

    // "Restart": a brand-new runner discovers the pending render from the store.
    const runner = new JobRunner({ store, pixverse });
    const resumed = runner.resume();
    expect(resumed).toBe(1);
    await runner.tick();
    await runner.tick();
    expect(store.getProject(project.storyline.id).clips[sceneId].status).toBe('ready');
  });

  it('reports failures and gives up after maxAttempts on a stuck render', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const { project, sceneId } = await projectWithScene(store);

    // Failure case
    const { client: failing } = makeFakePixverse({ resultSequences: { 111: [8] } });
    await generateClip(store, failing, project.storyline.id, sceneId, { wait: false });
    const runner = new JobRunner({ store, pixverse: failing });
    const events: JobEvent[] = [];
    runner.subscribe((e) => events.push(e));
    runner.track({ kind: 'clip', storylineId: project.storyline.id, sceneId });
    await runner.tick();
    expect(events.find((e) => e.type === 'done')?.status).toBe('failed');

    // Stuck case → timed_out safety valve
    const { client: stuck } = makeFakePixverse({ defaultStatus: 5 });
    const clip2 = await generateClip(store, stuck, project.storyline.id, sceneId, { wait: false });
    expect(clip2.status).toBe('generating');
    const runner2 = new JobRunner({ store, pixverse: stuck, maxAttempts: 2 });
    const events2: JobEvent[] = [];
    runner2.subscribe((e) => events2.push(e));
    runner2.track({ kind: 'clip', storylineId: project.storyline.id, sceneId });
    await runner2.tick();
    await runner2.tick();
    expect(runner2.pending()).toHaveLength(0);
    expect(events2.find((e) => e.type === 'done')?.status).toBe('timed_out');
  });
});

describe('async rendering over HTTP', () => {
  function makeApp(pixverseOpts: Parameters<typeof makeFakePixverse>[0] = {}) {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const { client: claude } = makeFakeClaude();
    const { client: pixverse } = makeFakePixverse(pixverseOpts);
    const jobs = new JobRunner({ store, pixverse }); // not started — tests tick manually
    const deps: AppDeps = {
      store,
      claude,
      pixverse,
      youtube: makeDryRunYoutube(),
      generateDefaults: { pollIntervalMs: 1, sleep: noSleep },
      jobs,
    };
    return { app: createApp(deps), store, jobs };
  }

  it('acknowledges an async submit, tracks the job, and completes it in the background', async () => {
    const { app, jobs } = makeApp({ resultSequences: { 111: [5, 1] } });

    const storyId = (await request(app).post('/api/stories').send({ title: 'S' }).expect(201)).body.story.id;
    await request(app).put(`/api/stories/${storyId}/bible`).send({ markdown: '# Bible\nCat.' }).expect(200);
    const episodeId = (
      await request(app).post(`/api/stories/${storyId}/episodes`).send({ title: 'E', brief: 'x' }).expect(201)
    ).body.episode.id;
    const storylineId = (
      await request(app).post(`/api/episodes/${episodeId}/storylines`).send({}).expect(201)
    ).body.project.storyline.id;
    const proj = await request(app).get(`/api/storylines/${storylineId}`).expect(200);
    const sceneId = proj.body.project.storyline.scenes[0].id;

    // Submit async — the response is an immediate acknowledgement.
    const submit = await request(app)
      .post(`/api/storylines/${storylineId}/scenes/${sceneId}/generate`)
      .send({ wait: false })
      .expect(200);
    expect(submit.body.clip.status).toBe('generating');

    // The job is visible as pending.
    const pending = await request(app).get('/api/jobs').expect(200);
    expect(pending.body.jobs).toHaveLength(1);
    expect(pending.body.jobs[0].kind).toBe('clip');

    // Background ticks complete it — no client polling involved.
    await jobs.tick();
    await jobs.tick();
    expect((await request(app).get('/api/jobs').expect(200)).body.jobs).toHaveLength(0);
    const after = await request(app).get(`/api/storylines/${storylineId}`).expect(200);
    expect(after.body.project.clips[sceneId].status).toBe('ready');
  });

  it('streams job events over SSE (init snapshot + done notification)', async () => {
    const { app, jobs, store } = makeApp({ resultSequences: { 111: [1] } });
    const { project, sceneId } = await projectWithScene(store);
    const { client: pixverse2 } = makeFakePixverse({ resultSequences: { 111: [5] } });
    await generateClip(store, pixverse2, project.storyline.id, sceneId, { wait: false });
    jobs.track({ kind: 'clip', storylineId: project.storyline.id, sceneId });

    const server = app.listen(0);
    cleanups.push(() => server.close());
    const port = (server.address() as AddressInfo).port;

    const frames: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/api/jobs/stream`, (res) => {
        res.on('data', (chunk: Buffer) => {
          frames.push(chunk.toString('utf8'));
          const joined = frames.join('');
          if (joined.includes('"type":"done"')) {
            req.destroy();
            resolve();
          } else if (joined.includes('"type":"init"')) {
            // Once connected (init received), complete the job.
            void jobs.tick();
          }
        });
        res.on('error', reject);
      });
      req.on('error', () => {
        /* destroyed intentionally */
      });
    });

    const joined = frames.join('');
    expect(joined).toContain('"type":"init"');
    expect(joined).toContain('"type":"done"');
    expect(joined).toContain('"status":"ready"');
  });
});
