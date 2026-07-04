import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp, type AppDeps } from '../src/app';
import { EventStore } from '../src/events/eventStore';
import {
  makeDryRunYoutube,
  makeFakeClaude,
  makeFakePixverse,
  makeStore,
  makeStudioFakeClaude,
  noSleep,
} from './helpers';

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

describe('preview, validation, and cost endpoints', () => {
  it('previews the AI context and validates render cost before committing', async () => {
    const { app } = makeApp();
    const storyId = (await request(app).post('/api/stories').send({ title: 'Cost Story' }).expect(201)).body.story.id;
    await request(app).put(`/api/stories/${storyId}/bible`).send({ markdown: '# Bible\nHero: a brave cat who explores space stations and helps robot friends every episode.' }).expect(200);
    const episodeId = (
      await request(app).post(`/api/stories/${storyId}/episodes`).send({ title: 'Ep 1', brief: 'Cat fixes a comet' }).expect(201)
    ).body.episode.id;

    // Preview the AI context before generating.
    const preview = await request(app).get(`/api/episodes/${episodeId}/storyline-preview`).expect(200);
    expect(preview.body.preview.markdown).toContain('Cat fixes a comet');
    expect(Array.isArray(preview.body.preview.checks)).toBe(true);

    // Generate, then validate the render cost.
    const storylineId = (
      await request(app).post(`/api/episodes/${episodeId}/storylines`).send({ model: 'claude-opus-4-8' }).expect(201)
    ).body.project.storyline.id;

    const validation = await request(app).get(`/api/storylines/${storylineId}/validate`).expect(200);
    expect(validation.body.validation.scenes.length).toBeGreaterThan(0);
    expect(validation.body.validation.totalUsd).toBeGreaterThan(0);
    expect(validation.body.validation.estUsdLabel).toMatch(/^\$/);
  });

  it('serves a cost report with the expected shape', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/costs/report').expect(200);
    expect(res.body.report).toHaveProperty('totalUsd');
    expect(res.body.report).toHaveProperty('byProvider');
    expect(res.body.report).toHaveProperty('tokens');
  });
});

describe('reference definition + publish history over HTTP', () => {
  it('returns a character definition with marks and a built prompt', async () => {
    const { client: studioClaude } = makeStudioFakeClaude();
    const { app } = makeApp({ claude: studioClaude });
    const storyId = (
      await request(app).post('/api/stories').send({ title: 'Ref Story', bible: 'Bobo is a monkey with a green scarf.' }).expect(201)
    ).body.story.id;
    await request(app).post(`/api/stories/${storyId}/canon/extract`).send({}).expect(201);

    const chars = await request(app).get(`/api/stories/${storyId}/characters`).expect(200);
    const entityId = Object.keys(chars.body.registry.characters).find((id) => id.startsWith('CHAR_'))!;

    const def = await request(app).get(`/api/stories/${storyId}/characters/${entityId}/definition`).expect(200);
    expect(def.body.definition.marks.length).toBeGreaterThan(0);
    expect(def.body.definition.builtPrompt).toBeTruthy();
    expect(def.body.definition.negativePrompt).toBeTruthy();
  });

  it('accumulates a publish history across attempts', async () => {
    const { app } = makeApp();
    const storyId = (await request(app).post('/api/stories').send({ title: 'Pub Story' }).expect(201)).body.story.id;
    await request(app).put(`/api/stories/${storyId}/bible`).send({ markdown: '# Bible\nHero cat.' }).expect(200);
    const episodeId = (
      await request(app).post(`/api/stories/${storyId}/episodes`).send({ title: 'E', brief: 'x' }).expect(201)
    ).body.episode.id;
    const storylineId = (
      await request(app).post(`/api/episodes/${episodeId}/storylines`).send({ model: 'claude-opus-4-8' }).expect(201)
    ).body.project.storyline.id;
    await request(app).post(`/api/storylines/${storylineId}/generate`).send({ wait: true }).expect(200);

    await request(app).post(`/api/storylines/${storylineId}/publish`).send({ privacyStatus: 'private' }).expect(200);
    await request(app).post(`/api/storylines/${storylineId}/publish`).send({ privacyStatus: 'unlisted' }).expect(200);

    const proj = await request(app).get(`/api/storylines/${storylineId}`).expect(200);
    expect(proj.body.project.publishHistory).toHaveLength(2);
    expect(proj.body.project.publish.status).toBe('published');
  });
});

describe('canon + drift over HTTP', () => {
  it('exposes dissection models in config and serves templates', async () => {
    const { app } = makeApp();
    const cfg = await request(app).get('/api/config').expect(200);
    expect(cfg.body.dissect.defaultModel).toBe('claude-sonnet-5');
    expect(cfg.body.dissect.models).toContain('claude-fable-5');

    const tpl = await request(app).get('/api/templates/story-bible?title=My%20Show').expect(200);
    expect(tpl.body.markdown).toContain('My Show — Story Bible');
    const ep = await request(app).get('/api/templates/episode-setting?title=Ep2').expect(200);
    expect(ep.body.markdown).toContain('Ep2 — Episode Setting');
  });

  it('extracts canon, checks drift, and resolves a finding end-to-end', async () => {
    const { client: studioClaude } = makeStudioFakeClaude();
    const { app } = makeApp({ claude: studioClaude });

    const storyRes = await request(app)
      .post('/api/stories')
      .send({
        title: 'Studio Story',
        bible: '# Bible\nBobo wears a bright green leaf scarf.',
        meta: { audienceMin: 4, audienceMax: 7, genres: ['comedy'] },
      })
      .expect(201);
    const storyId = storyRes.body.story.id;
    expect(storyRes.body.story.meta.audienceMax).toBe(7);

    // Extract canon (default Sonnet 5)
    const canonRes = await request(app).post(`/api/stories/${storyId}/canon/extract`).send({}).expect(201);
    expect(canonRes.body.registry.currentVersion).toBe(1);
    const boboId = canonRes.body.registry.versions[0].entities.find(
      (e: { name: string }) => e.name === 'Bobo',
    ).id;

    // Storyline generated against canon v1
    const epRes = await request(app).post(`/api/stories/${storyId}/episodes`).send({ title: 'Ep 1' }).expect(201);
    const slRes = await request(app).post(`/api/episodes/${epRes.body.episode.id}/storylines`).send({}).expect(201);
    const storylineId = slRes.body.project.storyline.id;
    expect(slRes.body.project.storyline.canonVersion).toBe(1);

    // Drift check
    const driftRes = await request(app).post(`/api/storylines/${storylineId}/drift-check`).send({}).expect(201);
    const report = driftRes.body.report;
    expect(report.findings.length).toBeGreaterThan(0);

    // Resolve with gradual acceptance → canon v2 with transitioning mark
    const resolveRes = await request(app)
      .post(`/api/storylines/${storylineId}/drift/${report.id}/findings/${report.findings[0].id}/resolve`)
      .send({ action: 'accept-gradually', note: 'ease into the redesign' })
      .expect(200);
    expect(resolveRes.body.finding.resolution.action).toBe('accept-gradually');
    expect(resolveRes.body.registry.currentVersion).toBe(2);

    // Manual mark edit endpoint → canon v3
    const patchRes = await request(app)
      .patch(`/api/stories/${storyId}/canon/entities/${boboId}/marks/fur_color`)
      .send({ value: 'honey-gold fur', note: 'palette tweak' })
      .expect(200);
    expect(patchRes.body.registry.currentVersion).toBe(3);

    // Registry endpoint reflects the full history
    const getRes = await request(app).get(`/api/stories/${storyId}/canon`).expect(200);
    expect(getRes.body.registry.versions).toHaveLength(3);
  });

  it('rejects an invalid drift resolution action', async () => {
    const { client: studioClaude } = makeStudioFakeClaude();
    const { app } = makeApp({ claude: studioClaude });
    const storyRes = await request(app).post('/api/stories').send({ title: 'S', bible: 'Bobo.' });
    const storyId = storyRes.body.story.id;
    await request(app).post(`/api/stories/${storyId}/canon/extract`).send({});
    const epRes = await request(app).post(`/api/stories/${storyId}/episodes`).send({ title: 'E' });
    const slRes = await request(app).post(`/api/episodes/${epRes.body.episode.id}/storylines`).send({});
    const storylineId = slRes.body.project.storyline.id;
    const driftRes = await request(app).post(`/api/storylines/${storylineId}/drift-check`).send({});
    const report = driftRes.body.report;
    await request(app)
      .post(`/api/storylines/${storylineId}/drift/${report.id}/findings/${report.findings[0].id}/resolve`)
      .send({ action: 'maybe-later' })
      .expect(400);
  });
});

describe('idea bootstrap over HTTP', () => {
  it('creates a fully-populated story (with canon) from an idea', async () => {
    const { client: studioClaude } = makeStudioFakeClaude();
    const { app } = makeApp({ claude: studioClaude });

    const res = await request(app)
      .post('/api/stories/bootstrap')
      .send({ idea: 'raccoon space program for kids' })
      .expect(201);
    expect(res.body.story.title).toBe('Rocket Raccoons');
    expect(res.body.story.meta.genres).toEqual(['comedy', 'sci-fi']);
    expect(res.body.registry.currentVersion).toBe(1); // withCanon defaults on

    const storyGet = await request(app).get(`/api/stories/${res.body.story.id}`).expect(200);
    expect(storyGet.body.bible).toContain('Rocket Raccoons — Story Bible');
  });

  it('drafts an episode without persisting it', async () => {
    const { client: studioClaude } = makeStudioFakeClaude();
    const { app } = makeApp({ claude: studioClaude });
    const storyRes = await request(app).post('/api/stories').send({ title: 'S', bible: 'b' });
    const storyId = storyRes.body.story.id;

    const draftRes = await request(app)
      .post(`/api/stories/${storyId}/episodes/draft`)
      .send({ idea: 'wobbly rocket' })
      .expect(200);
    expect(draftRes.body.draft.title).toBe('The Wobbly Launch');

    const storyGet = await request(app).get(`/api/stories/${storyId}`).expect(200);
    expect(storyGet.body.episodes).toHaveLength(0);
  });

  it('400s without an idea', async () => {
    const { app } = makeApp();
    await request(app).post('/api/stories/bootstrap').send({}).expect(400);
  });
});

describe('character reference images over HTTP', () => {
  it('syncs, generates, approves, and lists character portraits', async () => {
    const { client: studioClaude } = makeStudioFakeClaude();
    const { app } = makeApp({ claude: studioClaude });

    const storyRes = await request(app)
      .post('/api/stories')
      .send({ title: 'Char Story', bible: 'Bobo is a monkey with a green scarf.' });
    const storyId = storyRes.body.story.id;
    await request(app).post(`/api/stories/${storyId}/canon/extract`).send({}).expect(201);

    // Sync creates an asset per canon character.
    const list = await request(app).get(`/api/stories/${storyId}/characters`).expect(200);
    expect(Object.keys(list.body.registry.characters)).toContain('CHAR_BOBO_001');

    // Generate a portrait (defaults poll instantly via generateDefaults).
    const gen = await request(app)
      .post(`/api/stories/${storyId}/characters/CHAR_BOBO_001/portraits`)
      .send({})
      .expect(201);
    expect(gen.body.version.status).toBe('ready');
    expect(gen.body.version.version).toBe(1);

    // Tweak prompt → new version.
    const tweak = await request(app)
      .post(`/api/stories/${storyId}/characters/CHAR_BOBO_001/portraits`)
      .send({ source: 'tweak', promptOverride: 'Bobo with an explorer hat' })
      .expect(201);
    expect(tweak.body.version.version).toBe(2);
    expect(tweak.body.version.prompt).toBe('Bobo with an explorer hat');

    // Approve the first version.
    const approve = await request(app)
      .post(`/api/stories/${storyId}/characters/CHAR_BOBO_001/portraits/${gen.body.version.id}/approve`)
      .expect(200);
    expect(approve.body.asset.approvedVersionId).toBe(gen.body.version.id);
  });

  it('uploads a still as an approvable version', async () => {
    const { client: studioClaude } = makeStudioFakeClaude();
    const { app } = makeApp({ claude: studioClaude });
    const storyRes = await request(app).post('/api/stories').send({ title: 'S', bible: 'Bobo.' });
    const storyId = storyRes.body.story.id;
    await request(app).post(`/api/stories/${storyId}/canon/extract`).send({});
    const b64 = Buffer.from([1, 2, 3]).toString('base64');
    const up = await request(app)
      .post(`/api/stories/${storyId}/characters/CHAR_BOBO_001/still`)
      .send({ dataBase64: b64, contentType: 'image/png', filename: 'b.png' })
      .expect(201);
    expect(up.body.version.source).toBe('upload');
    expect(up.body.version.imageId).toBe(42);
  });
});

describe('season planning + episode generation over HTTP', () => {
  it('plans, generates, and extends a linear season', async () => {
    const { client: studioClaude } = makeStudioFakeClaude();
    const { app } = makeApp({ claude: studioClaude });

    const storyRes = await request(app)
      .post('/api/stories')
      .send({ title: 'Serial Show', continuity: 'linear', bible: 'Rizzo builds rockets.' })
      .expect(201);
    const storyId = storyRes.body.story.id;
    expect(storyRes.body.story.continuity).toBe('linear');

    const planRes = await request(app).post(`/api/stories/${storyId}/plan`).send({ episodeCount: 3 }).expect(201);
    expect(planRes.body.story.plan.episodes).toHaveLength(3);

    const genRes = await request(app)
      .post(`/api/stories/${storyId}/episodes/generate`)
      .send({ runtimeSec: 90 })
      .expect(201);
    expect(genRes.body.episode.plannedNumber).toBe(1);
    expect(genRes.body.episode.runtimeSec).toBe(90);
    expect(genRes.body.story.plan.episodes[0].episodeId).toBe(genRes.body.episode.id);

    const extRes = await request(app)
      .post(`/api/stories/${storyId}/plan/extend`)
      .send({ additionalEpisodes: 2 })
      .expect(200);
    expect(extRes.body.story.plan.episodes).toHaveLength(5);
  });

  it('rejects invalid runtimes and exposes runtimes in config', async () => {
    const { client: studioClaude } = makeStudioFakeClaude();
    const { app } = makeApp({ claude: studioClaude });
    const cfg = await request(app).get('/api/config').expect(200);
    expect(cfg.body.episodeRuntimes).toEqual([15, 30, 60, 90, 180, 300]);

    const storyRes = await request(app).post('/api/stories').send({ title: 'S', bible: 'b' });
    await request(app)
      .post(`/api/stories/${storyRes.body.story.id}/episodes/generate`)
      .send({ runtimeSec: 42 })
      .expect(400);
  });

  it('serves raw .md downloads for bible, setting, and templates', async () => {
    const { app } = makeApp();
    const storyRes = await request(app).post('/api/stories').send({ title: 'MD Story', bible: '# My Bible' });
    const storyId = storyRes.body.story.id;
    const epRes = await request(app)
      .post(`/api/stories/${storyId}/episodes`)
      .send({ title: 'E', setting: '# Ep Setting' });

    const bible = await request(app).get(`/api/stories/${storyId}/bible.md`).expect(200);
    expect(bible.headers['content-type']).toContain('text/markdown');
    expect(bible.headers['content-disposition']).toContain('md-story.bible.md');
    expect(bible.text).toBe('# My Bible');

    const setting = await request(app).get(`/api/episodes/${epRes.body.episode.id}/setting.md`).expect(200);
    expect(setting.text).toBe('# Ep Setting');

    const tpl = await request(app).get('/api/templates/story-bible.md?title=X').expect(200);
    expect(tpl.headers['content-disposition']).toContain('story-bible-template.md');
    expect(tpl.text).toContain('X — Story Bible');
    await request(app).get('/api/templates/episode-setting.md').expect(200);
  });
});

describe('story export/import over HTTP', () => {
  it('exports a downloadable .story.md and re-imports it', async () => {
    const { client: studioClaude } = makeStudioFakeClaude();
    const { app } = makeApp({ claude: studioClaude });

    const storyRes = await request(app)
      .post('/api/stories')
      .send({ title: 'Portable Show', bible: 'Bobo has a green scarf.', meta: { audienceMin: 4, audienceMax: 7 } });
    const storyId = storyRes.body.story.id;
    await request(app).post(`/api/stories/${storyId}/canon/extract`).send({});
    await request(app).post(`/api/stories/${storyId}/episodes`).send({ title: 'Ep 1', brief: 'b' });

    const exportRes = await request(app).get(`/api/stories/${storyId}/export`).expect(200);
    expect(exportRes.headers['content-type']).toContain('text/markdown');
    expect(exportRes.headers['content-disposition']).toContain('portable-show.story.md');
    expect(exportRes.text).toContain('pipbopshorts-story-export');

    const importRes = await request(app).post('/api/stories/import').send({ markdown: exportRes.text }).expect(201);
    expect(importRes.body.story.title).toBe('Portable Show');
    expect(importRes.body.story.id).not.toBe(storyId);
    expect(importRes.body.episodeCount).toBe(1);
    expect(importRes.body.canonVersions).toBe(1);
  });

  it('400s on an invalid import payload', async () => {
    const { app } = makeApp();
    await request(app).post('/api/stories/import').send({ markdown: 'not a package' }).expect(400);
    await request(app).post('/api/stories/import').send({}).expect(400);
  });
});

describe('CTA endpoint coverage', () => {
  /** Create a story→episode→storyline over HTTP and return the ids + a scene id. */
  async function scaffold(app: ReturnType<typeof makeApp>['app']) {
    const storyId = (await request(app).post('/api/stories').send({ title: 'CTA' }).expect(201)).body.story.id;
    await request(app).put(`/api/stories/${storyId}/bible`).send({ markdown: '# Bible\nHero cat.' }).expect(200);
    const episodeId = (
      await request(app).post(`/api/stories/${storyId}/episodes`).send({ title: 'E', brief: 'x' }).expect(201)
    ).body.episode.id;
    const project = (await request(app).post(`/api/episodes/${episodeId}/storylines`).send({}).expect(201)).body
      .project;
    return { storyId, episodeId, storylineId: project.storyline.id, scenes: project.storyline.scenes };
  }

  it('add, reorder, tweak, remove a scene, and edit youtube metadata', async () => {
    const { app } = makeApp();
    const { storylineId, scenes } = await scaffold(app);

    // Add a scene.
    const added = await request(app).post(`/api/storylines/${storylineId}/scenes`).send({ heading: 'New beat' }).expect(201);
    const ids: string[] = added.body.project.storyline.scenes.map((s: { id: string }) => s.id);
    expect(ids).toHaveLength(scenes.length + 1);

    // Reorder (reverse).
    const reordered = await request(app)
      .post(`/api/storylines/${storylineId}/reorder`)
      .send({ orderedIds: [...ids].reverse() })
      .expect(200);
    expect(reordered.body.project.storyline.scenes[0].id).toBe(ids[ids.length - 1]);

    // Remove the added scene.
    const removed = await request(app).delete(`/api/storylines/${storylineId}/scenes/${ids[ids.length - 1]}`).expect(200);
    expect(removed.body.project.storyline.scenes).toHaveLength(scenes.length);

    // YouTube metadata edit.
    const yt = await request(app)
      .patch(`/api/storylines/${storylineId}/youtube`)
      .send({ title: 'My Short', tags: ['a', 'b'] })
      .expect(200);
    expect(yt.body.project.storyline.youtube.title).toBe('My Short');

    // Bad reorder payload → 400.
    await request(app).post(`/api/storylines/${storylineId}/reorder`).send({}).expect(400);
  });

  it('refreshes and extends a rendered scene', async () => {
    const { app } = makeApp();
    const { storylineId, scenes } = await scaffold(app);
    const sceneId = scenes[0].id;
    await request(app).post(`/api/storylines/${storylineId}/scenes/${sceneId}/generate`).send({ wait: true }).expect(200);

    const refreshed = await request(app).post(`/api/storylines/${storylineId}/scenes/${sceneId}/refresh`).expect(200);
    expect(refreshed.body.clip.status).toBe('ready');

    const extended = await request(app)
      .post(`/api/storylines/${storylineId}/scenes/${sceneId}/extend`)
      .send({ wait: true })
      .expect(200);
    expect(extended.body.clip.status).toBe('ready');
  });

  it('auto-fixes invalid render parameters via the autofix CTA', async () => {
    const { client: studioClaude } = makeStudioFakeClaude();
    const { app, deps } = makeApp({ claude: studioClaude });
    const { storylineId, scenes } = await scaffold(app);

    // Force scene 1 into an invalid combo directly on the store (updateScene would reject it).
    const project = deps.store.getProject(storylineId);
    const scene = project.storyline.scenes.find((s) => s.id === scenes[0].id)!;
    scene.motionMode = 'fast';
    scene.duration = 8;
    deps.store.saveProject(project);

    // Validation reports the issue.
    const before = await request(app).get(`/api/storylines/${storylineId}/validate`).expect(200);
    expect(before.body.validation.ok).toBe(false);

    // Autofix resolves it and returns fresh validation.
    const fixed = await request(app).post(`/api/storylines/${storylineId}/autofix`).send({}).expect(200);
    expect(fixed.body.result.ok).toBe(true);
    expect(fixed.body.validation.ok).toBe(true);
    const after = deps.store.getProject(storylineId).storyline.scenes.find((s) => s.id === scenes[0].id)!;
    expect(after.duration).toBe(5);
    expect(after.prompt).toBe(scene.prompt); // creative content untouched
  });

  it('400s a drift check when no canon has been extracted', async () => {
    const { client: studioClaude } = makeStudioFakeClaude();
    const { app } = makeApp({ claude: studioClaude });
    const { storylineId } = await scaffold(app);
    const res = await request(app).post(`/api/storylines/${storylineId}/drift-check`).send({}).expect(400);
    expect(res.body.error).toMatch(/canon/i);
  });

  it('rejects a drift finding over HTTP without changing canon', async () => {
    const { client: studioClaude } = makeStudioFakeClaude();
    const { app } = makeApp({ claude: studioClaude });
    const storyId = (
      await request(app).post('/api/stories').send({ title: 'S', bible: 'Bobo has a green scarf.' }).expect(201)
    ).body.story.id;
    await request(app).post(`/api/stories/${storyId}/canon/extract`).send({}).expect(201);
    const episodeId = (await request(app).post(`/api/stories/${storyId}/episodes`).send({ title: 'E' }).expect(201)).body
      .episode.id;
    const storylineId = (await request(app).post(`/api/episodes/${episodeId}/storylines`).send({}).expect(201)).body
      .project.storyline.id;
    const report = (await request(app).post(`/api/storylines/${storylineId}/drift-check`).send({}).expect(201)).body
      .report;

    const rej = await request(app)
      .post(`/api/storylines/${storylineId}/drift/${report.id}/findings/${report.findings[0].id}/resolve`)
      .send({ action: 'reject' })
      .expect(200);
    expect(rej.body.finding.resolution.action).toBe('reject');
    expect(rej.body.registry).toBeNull();
    const canon = await request(app).get(`/api/stories/${storyId}/canon`).expect(200);
    expect(canon.body.registry.currentVersion).toBe(1);
  });
});

describe('global scene defaults, reference readiness, and mutation audit', () => {
  async function scaffold(app: ReturnType<typeof makeApp>['app']) {
    const storyId = (await request(app).post('/api/stories').send({ title: 'Bulk' }).expect(201)).body.story.id;
    await request(app).put(`/api/stories/${storyId}/bible`).send({ markdown: '# Bible\nHero cat.' }).expect(200);
    const episodeId = (
      await request(app).post(`/api/stories/${storyId}/episodes`).send({ title: 'E', brief: 'x' }).expect(201)
    ).body.episode.id;
    const project = (await request(app).post(`/api/episodes/${episodeId}/storylines`).send({}).expect(201)).body
      .project;
    return { storyId, episodeId, storylineId: project.storyline.id, scenes: project.storyline.scenes };
  }

  it('applies an aspect ratio to every scene at once', async () => {
    const { app } = makeApp();
    const { storylineId, scenes } = await scaffold(app);
    const res = await request(app)
      .post(`/api/storylines/${storylineId}/scene-defaults`)
      .send({ aspectRatio: '1:1' })
      .expect(200);
    expect(res.body.fields).toEqual(['aspectRatio']);
    expect(res.body.applied).toHaveLength(scenes.length);
    expect(res.body.project.storyline.scenes.every((s: { aspectRatio: string }) => s.aspectRatio === '1:1')).toBe(true);
  });

  it('skips scenes a bulk change would make invalid, applying to the rest', async () => {
    const { app } = makeApp();
    const { storylineId, scenes } = await scaffold(app);
    // Make scene 1 an 8s clip (valid on its own).
    await request(app)
      .patch(`/api/storylines/${storylineId}/scenes/${scenes[0].id}`)
      .send({ duration: 8 })
      .expect(200);
    // 1080p is capped at 5s, so scene 1 (now 8s) must be skipped; scene 2 (5s) applies.
    const res = await request(app)
      .post(`/api/storylines/${storylineId}/scene-defaults`)
      .send({ quality: '1080p' })
      .expect(200);
    expect(res.body.skipped.map((s: { sceneId: string }) => s.sceneId)).toContain(scenes[0].id);
    expect(res.body.applied).toContain(scenes[1].id);
    const after = res.body.project.storyline.scenes;
    expect(after.find((s: { id: string }) => s.id === scenes[0].id).quality).not.toBe('1080p');
    expect(after.find((s: { id: string }) => s.id === scenes[1].id).quality).toBe('1080p');
  });

  it('400s scene-defaults with no settings provided', async () => {
    const { app } = makeApp();
    const { storylineId } = await scaffold(app);
    await request(app).post(`/api/storylines/${storylineId}/scene-defaults`).send({}).expect(400);
  });

  it('reports reference readiness for a storyline', async () => {
    const { app } = makeApp();
    const { storylineId } = await scaffold(app);
    const res = await request(app).get(`/api/storylines/${storylineId}/reference-readiness`).expect(200);
    expect(res.body.readiness).toHaveProperty('items');
    expect(res.body.readiness).toHaveProperty('unapproved');
    expect(res.body.readiness).toHaveProperty('ready');
  });

  it('records a mutation audit event (old value preserved) when a storyline is deleted', async () => {
    const eventStore = new EventStore();
    const { app } = makeApp({ eventStore });
    const { storylineId } = await scaffold(app);
    await request(app).delete(`/api/storylines/${storylineId}`).expect(204);

    const events = await request(app).get('/api/events?service=store').expect(200);
    const del = events.body.events.find((e: { type: string }) => e.type === 'store.storyline.delete');
    expect(del).toBeTruthy();
    expect(del.method).toBe('DELETE');
    // The old value is preserved for audit / fail-safe restore.
    expect(del.request.before.storyline.id).toBe(storylineId);
  });

  it('restores a deleted storyline from its audit event (fail-safe)', async () => {
    const eventStore = new EventStore();
    const { app } = makeApp({ eventStore });
    const { storylineId } = await scaffold(app);
    await request(app).delete(`/api/storylines/${storylineId}`).expect(204);
    // Gone.
    await request(app).get(`/api/storylines/${storylineId}`).expect(404);

    const events = await request(app).get('/api/events?service=store').expect(200);
    const del = events.body.events.find((e: { type: string }) => e.type === 'store.storyline.delete');
    const restore = await request(app).post(`/api/audit/${del.id}/restore`).expect(200);
    expect(restore.body.restored.kind).toBe('storyline');
    expect(restore.body.restored.id).toBe(storylineId);
    // Back.
    const back = await request(app).get(`/api/storylines/${storylineId}`).expect(200);
    expect(back.body.project.storyline.id).toBe(storylineId);
  });

  it('restores a deleted story with its whole subtree (canon, characters, episodes, storylines)', async () => {
    const eventStore = new EventStore();
    const { client: studioClaude } = makeStudioFakeClaude();
    const { app } = makeApp({ eventStore, claude: studioClaude });

    const storyId = (
      await request(app).post('/api/stories').send({ title: 'Doomed', bible: 'Bobo has a green scarf.' }).expect(201)
    ).body.story.id;
    await request(app).post(`/api/stories/${storyId}/canon/extract`).send({}).expect(201);
    const episodeId = (await request(app).post(`/api/stories/${storyId}/episodes`).send({ title: 'E1', brief: 'b' }).expect(201))
      .body.episode.id;
    const storylineId = (await request(app).post(`/api/episodes/${episodeId}/storylines`).send({}).expect(201)).body
      .project.storyline.id;

    await request(app).delete(`/api/stories/${storyId}`).expect(204);
    await request(app).get(`/api/stories/${storyId}`).expect(404);

    const events = await request(app).get('/api/events?service=store').expect(200);
    const del = events.body.events.find((e: { type: string }) => e.type === 'store.story.delete');
    await request(app).post(`/api/audit/${del.id}/restore`).expect(200);

    // Story, canon, episode, and storyline are all back.
    const story = await request(app).get(`/api/stories/${storyId}`).expect(200);
    expect(story.body.story.title).toBe('Doomed');
    expect(story.body.episodes).toHaveLength(1);
    expect((await request(app).get(`/api/stories/${storyId}/canon`).expect(200)).body.registry.currentVersion).toBe(1);
    expect((await request(app).get(`/api/storylines/${storylineId}`).expect(200)).body.project.storyline.id).toBe(
      storylineId,
    );
  });

  it('restores a deleted episode with its storylines', async () => {
    const eventStore = new EventStore();
    const { app } = makeApp({ eventStore });
    const { episodeId, storylineId } = await scaffold(app);
    await request(app).delete(`/api/episodes/${episodeId}`).expect(204);
    await request(app).get(`/api/episodes/${episodeId}`).expect(404);

    const events = await request(app).get('/api/events?service=store').expect(200);
    const del = events.body.events.find((e: { type: string }) => e.type === 'store.episode.delete');
    const restored = await request(app).post(`/api/audit/${del.id}/restore`).expect(200);
    expect(restored.body.restored.kind).toBe('episode');
    await request(app).get(`/api/episodes/${episodeId}`).expect(200);
    expect((await request(app).get(`/api/storylines/${storylineId}`).expect(200)).body.project.storyline.id).toBe(
      storylineId,
    );
  });

  it('restores a deleted scene at its original position', async () => {
    const eventStore = new EventStore();
    const { app } = makeApp({ eventStore });
    const { storylineId, scenes } = await scaffold(app);
    const victim = scenes[0];
    await request(app).delete(`/api/storylines/${storylineId}/scenes/${victim.id}`).expect(200);

    const events = await request(app).get('/api/events?service=store').expect(200);
    const del = events.body.events.find((e: { type: string }) => e.type === 'store.scene.delete');
    await request(app).post(`/api/audit/${del.id}/restore`).expect(200);

    const back = await request(app).get(`/api/storylines/${storylineId}`).expect(200);
    const ids = back.body.project.storyline.scenes.map((s: { id: string }) => s.id);
    expect(ids).toContain(victim.id);
    expect(ids[0]).toBe(victim.id); // restored at original order 0
  });

  it('refuses to restore a storyline that already exists', async () => {
    const eventStore = new EventStore();
    const { app } = makeApp({ eventStore });
    const { storylineId } = await scaffold(app);
    await request(app).delete(`/api/storylines/${storylineId}`).expect(204);
    const events = await request(app).get('/api/events?service=store').expect(200);
    const del = events.body.events.find((e: { type: string }) => e.type === 'store.storyline.delete');
    await request(app).post(`/api/audit/${del.id}/restore`).expect(200);
    // Second restore should fail — it's back already.
    await request(app).post(`/api/audit/${del.id}/restore`).expect(400);
  });

  it('records a mutation audit event with before/after when a scene is edited', async () => {
    const eventStore = new EventStore();
    const { app } = makeApp({ eventStore });
    const { storylineId, scenes } = await scaffold(app);
    await request(app)
      .patch(`/api/storylines/${storylineId}/scenes/${scenes[0].id}`)
      .send({ heading: 'Renamed beat' })
      .expect(200);
    const events = await request(app).get('/api/events?service=store').expect(200);
    const edit = events.body.events.find((e: { type: string }) => e.type === 'store.scene.update');
    expect(edit).toBeTruthy();
    expect(edit.request.before.heading).toBe(scenes[0].heading);
    expect(edit.response.after.heading).toBe('Renamed beat');
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
