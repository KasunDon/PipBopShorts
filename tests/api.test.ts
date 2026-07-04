import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp, type AppDeps } from '../src/app';
import { EventStore } from '../src/events/eventStore';
import { makeDryRunYoutube, makeFakeClaude, makeFakePixverse, makeStore, noSleep } from './helpers';

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

function makeApp(overrides: Partial<AppDeps> = {}) {
  const { store, cleanup } = makeStore();
  cleanups.push(cleanup);
  const deps: AppDeps = {
    store,
    claude: makeFakeClaude().client,
    pixverse: makeFakePixverse({ defaultStatus: 1 }).client,
    youtube: makeDryRunYoutube(),
    generateDefaults: { pollIntervalMs: 1, sleep: noSleep },
    ...overrides,
  };
  return { app: createApp(deps), store };
}

/** Drive the pipeline up to a storyline and return its id + first scene id. */
async function scaffold(app: ReturnType<typeof makeApp>['app']) {
  const storyId = (await request(app).post('/api/stories').send({ title: 'S' }).expect(201)).body.story.id;
  await request(app).put(`/api/stories/${storyId}/bible`).send({ markdown: '# Bible\nHero cat.' }).expect(200);
  const episodeId = (
    await request(app).post(`/api/stories/${storyId}/episodes`).send({ title: 'E', brief: 'x' }).expect(201)
  ).body.episode.id;
  const project = (await request(app).post(`/api/episodes/${episodeId}/storylines`).send({}).expect(201)).body.project;
  return { storyId, episodeId, storylineId: project.storyline.id, scenes: project.storyline.scenes };
}

describe('end-to-end workflow over HTTP', () => {
  it('takes a story from creation through render, approval, and a (dry-run) publish', async () => {
    const { app } = makeApp();
    const { storylineId, scenes } = await scaffold(app);

    for (const scene of scenes) {
      await request(app).post(`/api/storylines/${storylineId}/scenes/${scene.id}/generate`).send({ wait: true }).expect(200);
    }

    // Publishing is gated on approval.
    await request(app).post(`/api/storylines/${storylineId}/publish`).send({}).expect(400);
    await request(app).post(`/api/storylines/${storylineId}/clips/approve-all`).expect(200);

    const published = await request(app).post(`/api/storylines/${storylineId}/publish`).send({ privacyStatus: 'unlisted' }).expect(200);
    expect(published.body.publish.status).toBe('published');
    expect(published.body.publish.dryRun).toBe(true);
  });

  it('exposes the config the console needs', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/config').expect(200);
    expect(res.body.claudeModels.map((m: { id: string }) => m.id)).toContain('claude-opus-4-8');
    expect(res.body.pixverse.qualities).toContain('540p');
  });
});

describe('error mapping', () => {
  it('404 for a missing story, 400 for a story with no title', async () => {
    const { app } = makeApp();
    await request(app).get('/api/stories/nope').expect(404);
    await request(app).post('/api/stories').send({}).expect(400);
  });

  it('400 when a scene edit would produce invalid render parameters', async () => {
    const { app } = makeApp();
    const { storylineId, scenes } = await scaffold(app);
    await request(app)
      .patch(`/api/storylines/${storylineId}/scenes/${scenes[0].id}`)
      .send({ quality: '1080p', duration: 8 })
      .expect(400);
  });

  it('422 when Claude refuses the request', async () => {
    const refusing = makeFakeClaude(() => ({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] })).client;
    const { app } = makeApp({ claude: refusing });
    const storyId = (await request(app).post('/api/stories').send({ title: 'S' }).expect(201)).body.story.id;
    const episodeId = (await request(app).post(`/api/stories/${storyId}/episodes`).send({ title: 'E' }).expect(201)).body.episode.id;
    await request(app).post(`/api/episodes/${episodeId}/storylines`).send({}).expect(422);
  });
});

describe('mutation audit and restore (the fail-safe)', () => {
  it('records a delete with the old value preserved, then restores the storyline from it', async () => {
    const eventStore = new EventStore();
    const { app } = makeApp({ eventStore });
    const { storylineId } = await scaffold(app);

    await request(app).delete(`/api/storylines/${storylineId}`).expect(204);
    await request(app).get(`/api/storylines/${storylineId}`).expect(404);

    const events = await request(app).get('/api/events?service=store').expect(200);
    const del = events.body.events.find((e: { type: string }) => e.type === 'store.storyline.delete');
    expect(del.request.before.storyline.id).toBe(storylineId);

    await request(app).post(`/api/audit/${del.id}/restore`).expect(200);
    await request(app).get(`/api/storylines/${storylineId}`).expect(200);
  });

  it('records before/after when a scene is edited', async () => {
    const eventStore = new EventStore();
    const { app } = makeApp({ eventStore });
    const { storylineId, scenes } = await scaffold(app);

    await request(app).patch(`/api/storylines/${storylineId}/scenes/${scenes[0].id}`).send({ heading: 'Renamed' }).expect(200);
    const events = await request(app).get('/api/events?service=store').expect(200);
    const edit = events.body.events.find((e: { type: string }) => e.type === 'store.scene.update');
    expect(edit.request.before.heading).toBe(scenes[0].heading);
    expect(edit.response.after.heading).toBe('Renamed');
  });
});

describe('global scene settings', () => {
  it('applies a setting to every scene, skipping any it would invalidate', async () => {
    const { app } = makeApp();
    const { storylineId, scenes } = await scaffold(app);
    // Make scene 1 an 8s clip; applying 1080p (5s only) must then skip it.
    await request(app).patch(`/api/storylines/${storylineId}/scenes/${scenes[0].id}`).send({ duration: 8 }).expect(200);
    const res = await request(app).post(`/api/storylines/${storylineId}/scene-defaults`).send({ quality: '1080p' }).expect(200);
    expect(res.body.skipped.map((s: { sceneId: string }) => s.sceneId)).toContain(scenes[0].id);
    expect(res.body.applied).toContain(scenes[1].id);
  });
});
