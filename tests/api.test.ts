import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp, type AppDeps } from '../src/app';
import { makeDryRunYoutube, makeFakeClaude, makeFakePixverse, makeStore, noSleep } from './helpers';

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

function makeApp(overrides: Partial<AppDeps> = {}) {
  const { store, cleanup } = makeStore();
  cleanups.push(cleanup);
  const { client: claude } = makeFakeClaude();
  const { client: pixverse } = makeFakePixverse({ defaultStatus: 1 });
  const deps: AppDeps = {
    store,
    claude,
    pixverse,
    youtube: makeDryRunYoutube(),
    generateDefaults: { pollIntervalMs: 1, sleep: noSleep },
    ...overrides,
  };
  return { app: createApp(deps), deps };
}

describe('meta endpoints', () => {
  it('health check', async () => {
    const { app } = makeApp();
    await request(app).get('/api/health').expect(200, { ok: true });
  });

  it('config lists models and pixverse options', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/config').expect(200);
    expect(res.body.claudeModels.map((m: { id: string }) => m.id)).toContain('claude-opus-4-8');
    expect(res.body.pixverse.qualities).toContain('540p');
    expect(res.body.youtubeDryRun).toBe(true);
  });
});

describe('full workflow over HTTP', () => {
  it('creates a story, episode, storyline, renders, and publishes', async () => {
    const { app } = makeApp();

    // Create story
    const storyRes = await request(app).post('/api/stories').send({ title: 'HTTP Story' }).expect(201);
    const storyId = storyRes.body.story.id;

    // Update bible
    await request(app).put(`/api/stories/${storyId}/bible`).send({ markdown: '# Bible\nHero: cat.' }).expect(200);
    const storyGet = await request(app).get(`/api/stories/${storyId}`).expect(200);
    expect(storyGet.body.bible).toContain('Hero: cat.');

    // Create episode
    const epRes = await request(app)
      .post(`/api/stories/${storyId}/episodes`)
      .send({ title: 'Ep 1', brief: 'Cat in space' })
      .expect(201);
    const episodeId = epRes.body.episode.id;

    // Generate storyline
    const slRes = await request(app)
      .post(`/api/episodes/${episodeId}/storylines`)
      .send({ model: 'claude-opus-4-8', effort: 'high' })
      .expect(201);
    const project = slRes.body.project;
    const storylineId = project.storyline.id;
    expect(project.storyline.scenes.length).toBe(2);

    // Tweak a scene
    const sceneId = project.storyline.scenes[0].id;
    const tweak = await request(app)
      .patch(`/api/storylines/${storylineId}/scenes/${sceneId}`)
      .send({ prompt: 'a tweaked prompt', motionMode: 'fast' })
      .expect(200);
    expect(tweak.body.project.storyline.scenes[0].prompt).toBe('a tweaked prompt');

    // Render one scene
    const genRes = await request(app)
      .post(`/api/storylines/${storylineId}/scenes/${sceneId}/generate`)
      .send({ wait: true })
      .expect(200);
    expect(genRes.body.clip.status).toBe('ready');

    // Render all
    const genAll = await request(app).post(`/api/storylines/${storylineId}/generate`).send({ wait: true }).expect(200);
    for (const scene of genAll.body.project.storyline.scenes) {
      expect(genAll.body.project.clips[scene.id].status).toBe('ready');
    }

    // Publish
    const pubRes = await request(app)
      .post(`/api/storylines/${storylineId}/publish`)
      .send({ privacyStatus: 'unlisted' })
      .expect(200);
    expect(pubRes.body.publish.status).toBe('published');
    expect(pubRes.body.publish.dryRun).toBe(true);
  });
});

describe('error handling', () => {
  it('404 for a missing story', async () => {
    const { app } = makeApp();
    await request(app).get('/api/stories/does-not-exist').expect(404);
  });

  it('400 for a story without a title', async () => {
    const { app } = makeApp();
    await request(app).post('/api/stories').send({}).expect(400);
  });

  it('400 for an invalid scene tweak with issues', async () => {
    const { app } = makeApp();
    const storyRes = await request(app).post('/api/stories').send({ title: 'S' });
    const epRes = await request(app)
      .post(`/api/stories/${storyRes.body.story.id}/episodes`)
      .send({ title: 'E' });
    const slRes = await request(app).post(`/api/episodes/${epRes.body.episode.id}/storylines`).send({});
    const storylineId = slRes.body.project.storyline.id;
    const sceneId = slRes.body.project.storyline.scenes[0].id;
    const res = await request(app)
      .patch(`/api/storylines/${storylineId}/scenes/${sceneId}`)
      .send({ quality: '1080p', duration: 8 })
      .expect(400);
    expect(res.body.error).toBeTruthy();
  });

  it('422 when Claude refuses', async () => {
    const { client: refusingClaude } = makeFakeClaude(() => ({
      stop_reason: 'refusal',
      stop_details: { category: 'cyber' },
      content: [],
    }));
    const { app } = makeApp({ claude: refusingClaude });
    const storyRes = await request(app).post('/api/stories').send({ title: 'S' });
    const epRes = await request(app)
      .post(`/api/stories/${storyRes.body.story.id}/episodes`)
      .send({ title: 'E' });
    await request(app).post(`/api/episodes/${epRes.body.episode.id}/storylines`).send({}).expect(422);
  });
});
