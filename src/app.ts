import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnthropicLike } from './clients/claude';
import { ClaudeError } from './clients/claude';
import { PixverseClient, PixverseError, ValidationError } from './clients/pixverse';
import type { YoutubeClient } from './clients/youtube';
import {
  CLAUDE_EFFORTS,
  CLAUDE_MODELS,
  PIXVERSE_ASPECT_RATIOS,
  PIXVERSE_CAMERA_MOVEMENTS,
  PIXVERSE_DURATIONS,
  PIXVERSE_MODELS,
  PIXVERSE_MOTION_MODES,
  PIXVERSE_QUALITIES,
  PIXVERSE_STYLES,
} from './constants';
import { DEFAULT_DISSECT_MODEL, DISSECT_MODELS, extractCanon, patchMark } from './services/canon';
import { checkDrift, resolveDrift } from './services/drift';
import { exportFilename, exportStory, ImportError, importStory } from './services/exchange';
import {
  extendClip,
  generateAllClips,
  generateClip,
  refreshClip,
  uploadReferenceImage,
  type GenerateOptions,
} from './services/generation';
import { episodeSettingTemplate, storyBibleTemplate } from './templates';
import { publishProject } from './services/publish';
import {
  addScene,
  createStorylineProject,
  removeScene,
  reorderScenes,
  updateScene,
  updateYoutubeMeta,
} from './services/storyline';
import { NotFoundError, type Store } from './store/store';

export interface AppDeps {
  store: Store;
  claude: AnthropicLike;
  pixverse: PixverseClient;
  youtube: YoutubeClient;
  /** Default poll/wait options for generation (tests inject a fast sleep). */
  generateDefaults?: Omit<GenerateOptions, 'wait'>;
  /** Path to a built web app to serve statically. */
  webDir?: string;
}

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;

function asyncHandler(fn: Handler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.use(express.json({ limit: '30mb' }));

  const genOpts = (body: Record<string, unknown>): GenerateOptions => ({
    ...deps.generateDefaults,
    wait: body?.wait === undefined ? true : Boolean(body.wait),
  });

  // ---- Meta ----
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/config', (_req, res) => {
    res.json({
      claudeModels: CLAUDE_MODELS,
      efforts: CLAUDE_EFFORTS,
      pixverse: {
        models: PIXVERSE_MODELS,
        qualities: PIXVERSE_QUALITIES,
        durations: PIXVERSE_DURATIONS,
        aspectRatios: PIXVERSE_ASPECT_RATIOS,
        motionModes: PIXVERSE_MOTION_MODES,
        styles: PIXVERSE_STYLES,
        cameraMovements: PIXVERSE_CAMERA_MOVEMENTS,
      },
      youtubeDryRun: deps.youtube.isDryRun,
      dissect: { models: DISSECT_MODELS, defaultModel: DEFAULT_DISSECT_MODEL },
    });
  });

  // ---- Templates ----
  app.get('/api/templates/story-bible', (req, res) => {
    const title = typeof req.query.title === 'string' ? req.query.title : 'Untitled Story';
    res.json({ markdown: storyBibleTemplate(title) });
  });

  app.get('/api/templates/episode-setting', (req, res) => {
    const title = typeof req.query.title === 'string' ? req.query.title : 'Untitled Episode';
    res.json({ markdown: episodeSettingTemplate(title) });
  });

  // ---- Stories ----
  app.get(
    '/api/stories',
    asyncHandler((_req, res) => {
      res.json({ stories: deps.store.listStories() });
    }),
  );

  app.post(
    '/api/stories',
    asyncHandler((req, res) => {
      const { title, settingMode, bible, meta } = req.body ?? {};
      if (!title || typeof title !== 'string') throw new HttpError(400, 'title is required');
      const story = deps.store.createStory({ title, settingMode, bible, meta });
      res.status(201).json({ story });
    }),
  );

  app.get(
    '/api/stories/:storyId',
    asyncHandler((req, res) => {
      const story = deps.store.getStory(req.params.storyId);
      res.json({
        story,
        bible: deps.store.getBible(story.id),
        episodes: deps.store.listEpisodes(story.id),
      });
    }),
  );

  app.patch(
    '/api/stories/:storyId',
    asyncHandler((req, res) => {
      const story = deps.store.updateStory(req.params.storyId, req.body ?? {});
      res.json({ story });
    }),
  );

  app.delete(
    '/api/stories/:storyId',
    asyncHandler((req, res) => {
      deps.store.deleteStory(req.params.storyId);
      res.status(204).end();
    }),
  );

  app.get(
    '/api/stories/:storyId/bible',
    asyncHandler((req, res) => {
      res.json({ markdown: deps.store.getBible(req.params.storyId) });
    }),
  );

  app.put(
    '/api/stories/:storyId/bible',
    asyncHandler((req, res) => {
      const { markdown } = req.body ?? {};
      if (typeof markdown !== 'string') throw new HttpError(400, 'markdown is required');
      deps.store.setBible(req.params.storyId, markdown);
      res.json({ markdown });
    }),
  );

  // ---- Story export / import (.story.md package) ----
  app.get(
    '/api/stories/:storyId/export',
    asyncHandler((req, res) => {
      const story = deps.store.getStory(req.params.storyId);
      const markdown = exportStory(deps.store, story.id);
      res
        .type('text/markdown; charset=utf-8')
        .setHeader('Content-Disposition', `attachment; filename="${exportFilename(story)}"`)
        .send(markdown);
    }),
  );

  app.post(
    '/api/stories/import',
    asyncHandler((req, res) => {
      const { markdown } = req.body ?? {};
      if (typeof markdown !== 'string' || !markdown.trim()) {
        throw new HttpError(400, 'markdown (the .story.md file content) is required');
      }
      const result = importStory(deps.store, markdown);
      res.status(201).json({
        story: result.story,
        episodeCount: result.episodes.length,
        storylineCount: result.storylineCount,
        canonVersions: result.canonVersions,
      });
    }),
  );

  // ---- Canon registry ----
  app.get(
    '/api/stories/:storyId/canon',
    asyncHandler((req, res) => {
      const registry = deps.store.getCanonRegistry(req.params.storyId);
      res.json({ registry });
    }),
  );

  app.post(
    '/api/stories/:storyId/canon/extract',
    asyncHandler(async (req, res) => {
      const { model, effort, note } = req.body ?? {};
      const registry = await extractCanon(deps.store, deps.claude, req.params.storyId, { model, effort, note });
      res.status(201).json({ registry });
    }),
  );

  app.patch(
    '/api/stories/:storyId/canon/entities/:entityId/marks/:markKey',
    asyncHandler((req, res) => {
      const registry = patchMark(
        deps.store,
        req.params.storyId,
        req.params.entityId,
        req.params.markKey,
        req.body ?? {},
      );
      res.json({ registry });
    }),
  );

  // ---- Drift (consistency) checks ----
  app.post(
    '/api/storylines/:storylineId/drift-check',
    asyncHandler(async (req, res) => {
      const { model, effort } = req.body ?? {};
      const report = await checkDrift(deps.store, deps.claude, req.params.storylineId, { model, effort });
      res.status(201).json({ report });
    }),
  );

  app.post(
    '/api/storylines/:storylineId/drift/:reportId/findings/:findingId/resolve',
    asyncHandler((req, res) => {
      const { action, note } = req.body ?? {};
      if (!['accept-now', 'accept-gradually', 'reject'].includes(action)) {
        throw new HttpError(400, 'action must be accept-now, accept-gradually, or reject');
      }
      const result = resolveDrift(
        deps.store,
        req.params.storylineId,
        req.params.reportId,
        req.params.findingId,
        action,
        note,
      );
      res.json({ finding: result.finding, registry: result.registry });
    }),
  );

  // ---- Episodes ----
  app.post(
    '/api/stories/:storyId/episodes',
    asyncHandler((req, res) => {
      const { title, brief, setting } = req.body ?? {};
      if (!title || typeof title !== 'string') throw new HttpError(400, 'title is required');
      const episode = deps.store.createEpisode(req.params.storyId, { title, brief, setting });
      res.status(201).json({ episode });
    }),
  );

  app.get(
    '/api/episodes/:episodeId',
    asyncHandler((req, res) => {
      const episode = deps.store.getEpisode(req.params.episodeId);
      const projects = deps.store.listProjectsByEpisode(episode.id).map((p) => ({
        storylineId: p.storyline.id,
        title: p.storyline.title,
        model: p.storyline.model,
        effort: p.storyline.effort,
        sceneCount: p.storyline.scenes.length,
        createdAt: p.storyline.createdAt,
        publish: p.publish,
      }));
      res.json({ episode, setting: deps.store.getSetting(episode.id), projects });
    }),
  );

  app.patch(
    '/api/episodes/:episodeId',
    asyncHandler((req, res) => {
      const episode = deps.store.updateEpisode(req.params.episodeId, req.body ?? {});
      res.json({ episode });
    }),
  );

  app.delete(
    '/api/episodes/:episodeId',
    asyncHandler((req, res) => {
      deps.store.deleteEpisode(req.params.episodeId);
      res.status(204).end();
    }),
  );

  app.get(
    '/api/episodes/:episodeId/setting',
    asyncHandler((req, res) => {
      res.json({ markdown: deps.store.getSetting(req.params.episodeId) });
    }),
  );

  app.put(
    '/api/episodes/:episodeId/setting',
    asyncHandler((req, res) => {
      const { markdown } = req.body ?? {};
      if (typeof markdown !== 'string') throw new HttpError(400, 'markdown is required');
      deps.store.setSetting(req.params.episodeId, markdown);
      res.json({ markdown });
    }),
  );

  // ---- Storyline generation ----
  app.post(
    '/api/episodes/:episodeId/storylines',
    asyncHandler(async (req, res) => {
      const episode = deps.store.getEpisode(req.params.episodeId);
      const project = await createStorylineProject(deps.store, deps.claude, episode.storyId, episode.id, req.body ?? {});
      res.status(201).json({ project });
    }),
  );

  app.get(
    '/api/storylines/:storylineId',
    asyncHandler((req, res) => {
      res.json({ project: deps.store.getProject(req.params.storylineId) });
    }),
  );

  app.delete(
    '/api/storylines/:storylineId',
    asyncHandler((req, res) => {
      deps.store.deleteProject(req.params.storylineId);
      res.status(204).end();
    }),
  );

  // ---- Scene editing (tweaking) ----
  app.patch(
    '/api/storylines/:storylineId/scenes/:sceneId',
    asyncHandler((req, res) => {
      const project = updateScene(deps.store, req.params.storylineId, req.params.sceneId, req.body ?? {});
      res.json({ project });
    }),
  );

  app.post(
    '/api/storylines/:storylineId/scenes',
    asyncHandler((req, res) => {
      const project = addScene(deps.store, req.params.storylineId, req.body ?? {});
      res.status(201).json({ project });
    }),
  );

  app.delete(
    '/api/storylines/:storylineId/scenes/:sceneId',
    asyncHandler((req, res) => {
      const project = removeScene(deps.store, req.params.storylineId, req.params.sceneId);
      res.json({ project });
    }),
  );

  app.post(
    '/api/storylines/:storylineId/reorder',
    asyncHandler((req, res) => {
      const orderedIds = req.body?.orderedIds;
      if (!Array.isArray(orderedIds)) throw new HttpError(400, 'orderedIds (array) is required');
      const project = reorderScenes(deps.store, req.params.storylineId, orderedIds);
      res.json({ project });
    }),
  );

  app.patch(
    '/api/storylines/:storylineId/youtube',
    asyncHandler((req, res) => {
      const project = updateYoutubeMeta(deps.store, req.params.storylineId, req.body ?? {});
      res.json({ project });
    }),
  );

  // ---- Rendering (PixVerse) ----
  app.post(
    '/api/storylines/:storylineId/scenes/:sceneId/generate',
    asyncHandler(async (req, res) => {
      const clip = await generateClip(
        deps.store,
        deps.pixverse,
        req.params.storylineId,
        req.params.sceneId,
        genOpts(req.body ?? {}),
      );
      res.json({ clip });
    }),
  );

  app.post(
    '/api/storylines/:storylineId/generate',
    asyncHandler(async (req, res) => {
      const project = await generateAllClips(deps.store, deps.pixverse, req.params.storylineId, genOpts(req.body ?? {}));
      res.json({ project });
    }),
  );

  app.post(
    '/api/storylines/:storylineId/scenes/:sceneId/refresh',
    asyncHandler(async (req, res) => {
      const clip = await refreshClip(deps.store, deps.pixverse, req.params.storylineId, req.params.sceneId);
      res.json({ clip });
    }),
  );

  app.post(
    '/api/storylines/:storylineId/scenes/:sceneId/extend',
    asyncHandler(async (req, res) => {
      const clip = await extendClip(
        deps.store,
        deps.pixverse,
        req.params.storylineId,
        req.params.sceneId,
        genOpts(req.body ?? {}),
      );
      res.json({ clip });
    }),
  );

  // Attach a reference image to a scene (base64 payload).
  app.post(
    '/api/storylines/:storylineId/scenes/:sceneId/image',
    asyncHandler(async (req, res) => {
      const { dataBase64, contentType, filename } = req.body ?? {};
      if (!dataBase64 || typeof dataBase64 !== 'string') throw new HttpError(400, 'dataBase64 is required');
      const bytes = new Uint8Array(Buffer.from(dataBase64, 'base64'));
      const uploaded = await uploadReferenceImage(deps.pixverse, bytes, filename, contentType);
      const project = updateScene(deps.store, req.params.storylineId, req.params.sceneId, {
        imageId: uploaded.imgId,
        imageUrl: uploaded.imgUrl,
      });
      res.json({ project, image: uploaded });
    }),
  );

  // ---- Publishing ----
  app.post(
    '/api/storylines/:storylineId/publish',
    asyncHandler(async (req, res) => {
      const record = await publishProject(deps.store, deps.youtube, req.params.storylineId, req.body ?? {});
      res.json({ publish: record });
    }),
  );

  // ---- Static web app (optional) ----
  if (deps.webDir && fs.existsSync(deps.webDir)) {
    app.use(express.static(deps.webDir));
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(path.join(deps.webDir as string, 'index.html'));
    });
  }

  // ---- Error handling ----
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const { status, body } = mapError(err);
    res.status(status).json(body);
  });

  return app;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function mapError(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof HttpError) return { status: err.status, body: { error: err.message } };
  if (err instanceof NotFoundError) return { status: 404, body: { error: err.message } };
  if (err instanceof ImportError) return { status: 400, body: { error: err.message } };
  if (err instanceof ValidationError) return { status: 400, body: { error: err.message, issues: err.issues } };
  if (err instanceof ClaudeError) {
    const status = err.kind === 'refusal' ? 422 : 400;
    return { status, body: { error: err.message, kind: err.kind } };
  }
  if (err instanceof PixverseError) return { status: 502, body: { error: err.message, errCode: err.errCode } };
  if (err instanceof Error && 'issues' in err) {
    return { status: 400, body: { error: err.message, issues: (err as { issues: unknown }).issues } };
  }
  const message = err instanceof Error ? err.message : 'Internal error';
  return { status: 500, body: { error: message } };
}

/** Resolve the default web build directory relative to this module. */
export function defaultWebDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'web', 'dist');
}
