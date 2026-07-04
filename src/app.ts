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
  EPISODE_RUNTIMES,
  PIXVERSE_ASPECT_RATIOS,
  PIXVERSE_CAMERA_MOVEMENTS,
  PIXVERSE_DURATIONS,
  PIXVERSE_MODELS,
  PIXVERSE_MOTION_MODES,
  PIXVERSE_QUALITIES,
  PIXVERSE_STYLES,
} from './constants';
import { bootstrapStory, draftEpisode } from './services/bootstrap';
import {
  DEFAULT_DISSECT_MODEL,
  DISSECT_MODELS,
  canonChangelog,
  currentCanonVersion,
  diffCanonByVersion,
  extractCanon,
  patchMark,
  seasonCanonSummary,
} from './services/canon';
import {
  approvePortrait,
  buildReferenceDefinition,
  generatePortrait,
  referenceReadiness,
  refreshPortrait,
  syncCharactersFromCanon,
  uploadPortraitStill,
} from './services/characters';
import { assertRuntime, extendPlan, generateNextEpisode, planStory } from './services/season';
import { storyAnalytics, studioAnalytics } from './services/analytics';
import { autofixStoryline } from './services/autofix';
import { generateBeatSheet } from './services/beatsheet';
import { buildShotManifest } from './services/manifest';
import { addSceneComment, deleteSceneComment, setSceneCommentResolved } from './services/comments';
import { planStorylineDialogue } from './services/dialogue';
import { qcScene } from './services/qc';
import { localizeYoutubeMeta } from './services/localize';
import { planStorylineSound } from './services/soundcues';
import { suggestTitleVariants } from './services/titles';
import { suggestThumbnailConcepts } from './services/thumbnails';
import { suggestEpisodeIdeas } from './services/ideas';
import { analyzePerformance } from './services/insights';
import { syncPerformance } from './services/performanceSync';
import { patchScene } from './services/patch';
import { checkDrift, resolveDrift } from './services/drift';
import { JobRunner } from './services/jobs';
import { restoreFromAudit } from './services/restore';
import { UserInputError } from './errors';
import { EventStore, type EventService, type EventStatus } from './events/eventStore';
import { withCostContext, type CostContext } from './costs/context';
import { buildCostReport, costLineItems } from './costs/report';
import { exportFilename, exportStory, ImportError, importStory } from './services/exchange';
import {
  extendClip,
  generateAllClips,
  generateClip,
  refreshClip,
  setClipApproval,
  uploadReferenceImage,
  type GenerateOptions,
} from './services/generation';
import { episodeSettingTemplate, storyBibleTemplate } from './templates';
import { buildCaptionsSrt } from './services/captions';
import { localizeCaptionsSrt } from './services/captionsLocalize';
import { buildStorylinePreview, validateStorylineForRender } from './services/preview';
import { productionReadiness } from './services/readiness';
import { publishProject } from './services/publish';
import { cancelRenderSchedule, cancelSchedule, schedulePublish, scheduleRender } from './services/scheduler';
import {
  addScene,
  applySceneDefaults,
  createStorylineProject,
  duplicateScene,
  duplicateStoryline,
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
  /** Audit log of outbound network calls; defaults to an in-memory-only store. */
  eventStore?: EventStore;
  /** Background runner completing async renders server-side; defaults to a non-started runner. */
  jobs?: JobRunner;
}

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;

/** Infer the production phase a request belongs to from its path, for cost attribution. */
function phaseFromPath(path: string): string | undefined {
  if (/\/canon\/extract/.test(path)) return 'canon';
  if (/\/characters\/[^/]+\/(portraits|still)/.test(path)) return 'reference';
  if (/\/stories\/bootstrap/.test(path)) return 'bootstrap';
  if (/\/episodes\/[^/]+\/storylines/.test(path)) return 'storyline';
  if (/\/episodes\/draft/.test(path)) return 'episode-draft';
  if (/\/episodes\/generate/.test(path)) return 'episode-gen';
  if (/\/plan/.test(path)) return 'season';
  if (/\/autofix/.test(path)) return 'autofix';
  if (/\/drift/.test(path)) return 'drift';
  if (/\/(generate|refresh|extend)\b|\/scenes\/[^/]+\/image/.test(path)) return 'clip';
  if (/\/publish/.test(path)) return 'publish';
  return undefined;
}

/**
 * Build the cost context for a request, resolving the full story/episode
 * ancestry so spend rolls up correctly. Route params only carry the deepest id
 * (e.g. a render route knows the storylineId but not the storyId) — we walk up
 * via the store so every penny is attributed to its story and episode, not just
 * the storyline. Best-effort: a not-yet-created record just leaves fields unset.
 */
function scopeFromRequest(store: Store, req: Request): CostContext {
  const p = (req.params ?? {}) as Record<string, string | undefined>;
  const ctx: CostContext = {
    storyId: p.storyId,
    episodeId: p.episodeId,
    storylineId: p.storylineId,
    sceneId: p.sceneId,
    entityId: p.entityId,
    phase: phaseFromPath(req.path),
  };
  try {
    if (ctx.storylineId && (!ctx.storyId || !ctx.episodeId)) {
      const project = store.getProject(ctx.storylineId);
      ctx.storyId ??= project.storyline.storyId;
      ctx.episodeId ??= project.storyline.episodeId;
    }
    if (ctx.episodeId && !ctx.storyId) {
      ctx.storyId = store.getEpisode(ctx.episodeId).storyId;
    }
  } catch {
    // Ancestry resolution is best-effort — leave unresolved ids unset.
  }
  return ctx;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.use(express.json({ limit: '30mb' }));
  const eventStore = deps.eventStore ?? new EventStore();
  const jobs = deps.jobs ?? new JobRunner({ store: deps.store, pixverse: deps.pixverse });

  const asyncHandler = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
    // Run within a cost context so any outbound call this handler makes is
    // attributed to the right story/episode/scene/phase in the audit log.
    withCostContext(scopeFromRequest(deps.store, req), () => Promise.resolve(fn(req, res)).catch(next));
  };

  /**
   * Record a data mutation (delete/update) in the audit log with the old value
   * preserved — an accountability trail and a fail-safe for destructive edits.
   * Never lets an auditing failure break the mutation it is recording.
   */
  const recordMutation = (
    req: Request,
    input: { resource: string; action: 'update' | 'delete'; summary: string; before: unknown; after?: unknown },
  ): void => {
    try {
      eventStore.record({
        durationMs: 0,
        service: 'store',
        type: `store.${input.resource}.${input.action}`,
        method: input.action.toUpperCase(),
        url: `store://${input.resource}`,
        status: 'ok',
        summary: input.summary,
        request: { before: input.before },
        response: { after: input.after ?? null },
        context: scopeFromRequest(deps.store, req),
      });
    } catch {
      // Auditing is best-effort; it must never break the operation it records.
    }
  };

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
      episodeRuntimes: EPISODE_RUNTIMES,
    });
  });

  // ---- Audit events (all outbound network / LLM / PixVerse calls) ----
  app.get('/api/events', (req, res) => {
    const { q, service, status, before, limit } = req.query;
    const result = eventStore.list({
      q: typeof q === 'string' ? q : undefined,
      service: typeof service === 'string' && service ? (service as EventService) : undefined,
      status: typeof status === 'string' && status ? (status as EventStatus) : undefined,
      before: typeof before === 'string' ? before : undefined,
      limit: limit !== undefined ? Number(limit) : undefined,
    });
    res.json(result);
  });

  app.get('/api/events/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(': connected\n\n');

    const unsubscribe = eventStore.subscribe((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  app.get(
    '/api/events/:id',
    asyncHandler((req, res) => {
      const event = eventStore.get(req.params.id);
      if (!event) throw new HttpError(404, `Event not found: ${req.params.id}`);
      res.json({ event });
    }),
  );

  app.delete('/api/events', (_req, res) => {
    eventStore.clear();
    res.status(204).end();
  });

  // Fail-safe: restore a deleted storyline/scene from the old value preserved in
  // its `store` audit event.
  app.post(
    '/api/audit/:eventId/restore',
    asyncHandler((req, res) => {
      const event = eventStore.get(req.params.eventId);
      if (!event) throw new HttpError(404, `Audit event not found: ${req.params.eventId}`);
      const restored = restoreFromAudit(deps.store, event);
      recordMutation(req, {
        resource: restored.kind,
        action: 'update',
        summary: `Restored ${restored.kind} "${restored.label}" from audit`,
        before: null,
        after: { id: restored.id },
      });
      res.json({ restored });
    }),
  );

  // ---- Background jobs (async renders processed server-side) ----
  app.get('/api/jobs', (_req, res) => {
    res.json({ jobs: jobs.pending() });
  });

  app.get('/api/jobs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    // Initial snapshot so a (re)connecting console can restore its pending count.
    res.write(`data: ${JSON.stringify({ type: 'init', jobs: jobs.pending() })}\n\n`);

    const unsubscribe = jobs.subscribe((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  // ---- Cost report (production spend across LLM + PixVerse) ----
  app.get('/api/costs/report', (req, res) => {
    const { storyId, episodeId, since } = req.query;
    const report = buildCostReport(eventStore.all(), {
      storyId: typeof storyId === 'string' ? storyId : undefined,
      episodeId: typeof episodeId === 'string' ? episodeId : undefined,
      since: typeof since === 'string' ? since : undefined,
    });
    res.json({ report });
  });

  // Penny-by-penny line items behind the totals — filter by story/episode to audit spend.
  app.get('/api/costs/events', (req, res) => {
    const { storyId, episodeId, since } = req.query;
    const items = costLineItems(eventStore.all(), {
      storyId: typeof storyId === 'string' ? storyId : undefined,
      episodeId: typeof episodeId === 'string' ? episodeId : undefined,
      since: typeof since === 'string' ? since : undefined,
    });
    res.json({ items });
  });

  // ---- Render presets (studio-wide render defaults) ----
  app.get(
    '/api/presets',
    asyncHandler((_req, res) => {
      res.json({ presets: deps.store.listPresets() });
    }),
  );

  app.post(
    '/api/presets',
    asyncHandler((req, res) => {
      const { name, aspectRatio, quality, model, motionMode, style, cameraMovement } = req.body ?? {};
      if (!name || typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'name is required');
      const preset = deps.store.createPreset({
        name: name.trim(),
        aspectRatio,
        quality,
        model,
        motionMode,
        style,
        cameraMovement,
      });
      res.status(201).json({ preset });
    }),
  );

  app.delete(
    '/api/presets/:presetId',
    asyncHandler((req, res) => {
      deps.store.deletePreset(req.params.presetId);
      res.status(204).end();
    }),
  );

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

  // Studio-wide analytics roll-up across every story (cross-IP dashboard).
  app.get(
    '/api/studio/analytics',
    asyncHandler((_req, res) => {
      res.json({ analytics: studioAnalytics(deps.store) });
    }),
  );

  app.post(
    '/api/stories',
    asyncHandler((req, res) => {
      const { title, settingMode, continuity, bible, meta } = req.body ?? {};
      if (!title || typeof title !== 'string') throw new HttpError(400, 'title is required');
      const story = deps.store.createStory({ title, settingMode, continuity, bible, meta });
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
      const before = { ...deps.store.getStory(req.params.storyId) }; // snapshot before in-place mutation
      const story = deps.store.updateStory(req.params.storyId, req.body ?? {});
      recordMutation(req, { resource: 'story', action: 'update', summary: `Edited story "${story.title}"`, before, after: { ...story } });
      res.json({ story });
    }),
  );

  app.delete(
    '/api/stories/:storyId',
    asyncHandler((req, res) => {
      // Snapshot the whole subtree before the cascade so it can be restored.
      const before = deps.store.snapshotStory(req.params.storyId);
      deps.store.deleteStory(req.params.storyId);
      recordMutation(req, {
        resource: 'story',
        action: 'delete',
        summary: `Deleted story "${before.story.title}" (${before.episodes.length} episodes)`,
        before,
      });
      res.status(204).end();
    }),
  );

  app.get(
    '/api/stories/:storyId/bible',
    asyncHandler((req, res) => {
      res.json({ markdown: deps.store.getBible(req.params.storyId) });
    }),
  );

  // Pull real performance for a story's published shorts from analytics (no-op until configured).
  app.post(
    '/api/stories/:storyId/performance-sync',
    asyncHandler(async (req, res) => {
      const result = await syncPerformance(deps.store, deps.youtube, req.params.storyId);
      res.json({ result, configured: !deps.youtube.isDryRun });
    }),
  );

  // Feed recorded performance back into the story formula (LLM analysis).
  app.post(
    '/api/stories/:storyId/performance-insights',
    asyncHandler(async (req, res) => {
      const { model, effort } = req.body ?? {};
      const insights = await analyzePerformance(deps.store, deps.claude, req.params.storyId, { model, effort });
      res.json({ insights });
    }),
  );

  // Per-story production analytics (volume, approval/publish progress, canon
  // stability, drift health) for the studio dashboard.
  app.get(
    '/api/stories/:storyId/analytics',
    asyncHandler((req, res) => {
      res.json({ analytics: storyAnalytics(deps.store, req.params.storyId) });
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

  // ---- Season planning & episode generation ----
  app.post(
    '/api/stories/:storyId/plan',
    asyncHandler(async (req, res) => {
      const { episodeCount, model, effort, replace } = req.body ?? {};
      if (!Number.isFinite(Number(episodeCount))) throw new HttpError(400, 'episodeCount is required');
      const story = await planStory(deps.store, deps.claude, req.params.storyId, {
        episodeCount: Number(episodeCount),
        model,
        effort,
        replace: Boolean(replace),
      });
      res.status(201).json({ story });
    }),
  );

  app.post(
    '/api/stories/:storyId/plan/extend',
    asyncHandler(async (req, res) => {
      const { additionalEpisodes, model, effort } = req.body ?? {};
      if (!Number.isFinite(Number(additionalEpisodes))) throw new HttpError(400, 'additionalEpisodes is required');
      const story = await extendPlan(deps.store, deps.claude, req.params.storyId, {
        additionalEpisodes: Number(additionalEpisodes),
        model,
        effort,
      });
      res.json({ story });
    }),
  );

  app.post(
    '/api/stories/:storyId/episodes/generate',
    asyncHandler(async (req, res) => {
      const { runtimeSec, model, effort, guidance } = req.body ?? {};
      const episode = await generateNextEpisode(deps.store, deps.claude, req.params.storyId, {
        runtimeSec: runtimeSec == null ? undefined : Number(runtimeSec),
        model,
        effort,
        guidance,
      });
      res.status(201).json({ episode, story: deps.store.getStory(req.params.storyId) });
    }),
  );

  // ---- Raw .md downloads ----
  const sendMarkdown = (res: Response, filename: string, markdown: string) => {
    res
      .type('text/markdown; charset=utf-8')
      .setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      .send(markdown);
  };

  app.get(
    '/api/stories/:storyId/bible.md',
    asyncHandler((req, res) => {
      const story = deps.store.getStory(req.params.storyId);
      sendMarkdown(res, `${story.slug}.bible.md`, deps.store.getBible(story.id));
    }),
  );

  app.get(
    '/api/episodes/:episodeId/setting.md',
    asyncHandler((req, res) => {
      const episode = deps.store.getEpisode(req.params.episodeId);
      sendMarkdown(res, `episode-setting.md`, deps.store.getSetting(episode.id));
    }),
  );

  app.get('/api/templates/story-bible.md', (req, res) => {
    const title = typeof req.query.title === 'string' ? req.query.title : 'Untitled Story';
    sendMarkdown(res, 'story-bible-template.md', storyBibleTemplate(title));
  });

  app.get('/api/templates/episode-setting.md', (req, res) => {
    const title = typeof req.query.title === 'string' ? req.query.title : 'Untitled Episode';
    sendMarkdown(res, 'episode-setting-template.md', episodeSettingTemplate(title));
  });

  // ---- LLM idea bootstrap ----
  app.post(
    '/api/stories/bootstrap',
    asyncHandler(async (req, res) => {
      const { idea, model, effort, withCanon } = req.body ?? {};
      if (!idea || typeof idea !== 'string' || !idea.trim()) throw new HttpError(400, 'idea is required');
      const result = await bootstrapStory(deps.store, deps.claude, {
        idea,
        model,
        effort,
        withCanon: withCanon !== false,
      });
      res.status(201).json({ story: result.story, registry: result.registry });
    }),
  );

  // Brainstorm a backlog of future episode ideas grounded in the bible + canon.
  app.post(
    '/api/stories/:storyId/episode-ideas',
    asyncHandler(async (req, res) => {
      const { count, model, effort } = req.body ?? {};
      const ideas = await suggestEpisodeIdeas(deps.store, deps.claude, req.params.storyId, {
        count: count == null ? undefined : Number(count),
        model,
        effort,
      });
      res.json({ ideas });
    }),
  );

  app.post(
    '/api/stories/:storyId/episodes/draft',
    asyncHandler(async (req, res) => {
      const { idea, model, effort } = req.body ?? {};
      if (!idea || typeof idea !== 'string' || !idea.trim()) throw new HttpError(400, 'idea is required');
      const draft = await draftEpisode(deps.store, deps.claude, req.params.storyId, idea, { model, effort });
      res.json({ draft });
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

  // Season-level canon: what must never change vs what may evolve.
  app.get(
    '/api/stories/:storyId/canon/season-summary',
    asyncHandler((req, res) => {
      const canon = currentCanonVersion(deps.store.getCanonRegistry(req.params.storyId));
      if (!canon) throw new HttpError(400, 'No canon registry for this story.');
      res.json({ summary: seasonCanonSummary(canon) });
    }),
  );

  // Season-wide canon changelog (every version's diff from the prior one).
  app.get(
    '/api/stories/:storyId/canon/changelog',
    asyncHandler((req, res) => {
      const registry = deps.store.getCanonRegistry(req.params.storyId);
      if (!registry) throw new HttpError(400, 'No canon registry for this story.');
      res.json({ changelog: canonChangelog(registry) });
    }),
  );

  // Changelog between two canon versions (defaults: previous → current).
  app.get(
    '/api/stories/:storyId/canon/diff',
    asyncHandler((req, res) => {
      const registry = deps.store.getCanonRegistry(req.params.storyId);
      const current = currentCanonVersion(registry);
      if (!registry || !current) throw new HttpError(400, 'No canon registry for this story.');
      const to = req.query.to !== undefined ? Number(req.query.to) : current.version;
      const from = req.query.from !== undefined ? Number(req.query.from) : to - 1;
      if (from < 1) {
        res.json({ diff: null });
        return;
      }
      res.json({ diff: diffCanonByVersion(registry, from, to) });
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
      recordMutation(req, {
        resource: 'canon-mark',
        action: 'update',
        summary: `Edited canon mark "${req.params.markKey}" → v${registry.currentVersion}`,
        before: { markKey: req.params.markKey, patch: req.body ?? {} },
        after: { canonVersion: registry.currentVersion },
      });
      res.json({ registry });
    }),
  );

  // ---- Character reference images ----
  app.get(
    '/api/stories/:storyId/characters',
    asyncHandler((req, res) => {
      const registry = syncCharactersFromCanon(deps.store, req.params.storyId);
      res.json({ registry });
    }),
  );

  // The canon marks + built render prompt for a character/location — reviewed
  // and (via promptOverride) editable before generating.
  app.get(
    '/api/stories/:storyId/characters/:entityId/definition',
    asyncHandler((req, res) => {
      res.json({ definition: buildReferenceDefinition(deps.store, req.params.storyId, req.params.entityId) });
    }),
  );

  app.post(
    '/api/stories/:storyId/characters/:entityId/portraits',
    asyncHandler(async (req, res) => {
      const { source, promptOverride, negativePrompt, model, quality, aspectRatio, style, wait, dataBase64, contentType, filename } =
        req.body ?? {};
      // An optional attached image seeds an image-to-video (image-guided) render.
      const sourceImageBytes =
        typeof dataBase64 === 'string' && dataBase64 ? new Uint8Array(Buffer.from(dataBase64, 'base64')) : undefined;
      const version = await generatePortrait(deps.store, deps.pixverse, req.params.storyId, req.params.entityId, {
        ...deps.generateDefaults,
        source,
        promptOverride,
        negativePrompt,
        model,
        quality,
        aspectRatio,
        style,
        sourceImageBytes,
        sourceImageFilename: typeof filename === 'string' ? filename : undefined,
        sourceImageContentType: typeof contentType === 'string' ? contentType : undefined,
        wait: wait === undefined ? true : Boolean(wait),
      });
      if (version.status === 'generating' && version.videoId != null) {
        jobs.track({ kind: 'portrait', storyId: req.params.storyId, entityId: req.params.entityId, versionId: version.id });
      }
      res.status(201).json({ version });
    }),
  );

  app.post(
    '/api/stories/:storyId/characters/:entityId/portraits/:versionId/refresh',
    asyncHandler(async (req, res) => {
      const version = await refreshPortrait(
        deps.store,
        deps.pixverse,
        req.params.storyId,
        req.params.entityId,
        req.params.versionId,
      );
      res.json({ version });
    }),
  );

  app.post(
    '/api/stories/:storyId/characters/:entityId/portraits/:versionId/approve',
    asyncHandler((req, res) => {
      const registry = deps.store.getCharacterRegistry(req.params.storyId);
      const beforeApproved = registry?.characters[req.params.entityId]?.approvedVersionId ?? null;
      const asset = approvePortrait(deps.store, req.params.storyId, req.params.entityId, req.params.versionId);
      recordMutation(req, {
        resource: 'reference-approval',
        action: 'update',
        summary: `Approved reference for "${asset.name}"`,
        before: { approvedVersionId: beforeApproved },
        after: { approvedVersionId: asset.approvedVersionId },
      });
      res.json({ asset });
    }),
  );

  app.post(
    '/api/stories/:storyId/characters/:entityId/still',
    asyncHandler(async (req, res) => {
      const { dataBase64, contentType, filename } = req.body ?? {};
      if (!dataBase64 || typeof dataBase64 !== 'string') throw new HttpError(400, 'dataBase64 is required');
      const bytes = new Uint8Array(Buffer.from(dataBase64, 'base64'));
      const version = await uploadPortraitStill(
        deps.store,
        deps.pixverse,
        req.params.storyId,
        req.params.entityId,
        bytes,
        filename,
        contentType,
      );
      res.status(201).json({ version });
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
      const { title, brief, setting, runtimeSec } = req.body ?? {};
      if (!title || typeof title !== 'string') throw new HttpError(400, 'title is required');
      const runtime = runtimeSec == null ? null : Number(runtimeSec);
      assertRuntime(runtime);
      const episode = deps.store.createEpisode(req.params.storyId, { title, brief, setting, runtimeSec: runtime });
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
      const before = { ...deps.store.getEpisode(req.params.episodeId) }; // snapshot before in-place mutation
      const episode = deps.store.updateEpisode(req.params.episodeId, req.body ?? {});
      recordMutation(req, {
        resource: 'episode',
        action: 'update',
        summary: `Edited episode "${episode.title}"`,
        before,
        after: { ...episode },
      });
      res.json({ episode });
    }),
  );

  app.delete(
    '/api/episodes/:episodeId',
    asyncHandler((req, res) => {
      // Snapshot the episode + its storylines before the cascade so it can be restored.
      const before = deps.store.snapshotEpisode(req.params.episodeId);
      deps.store.deleteEpisode(req.params.episodeId);
      recordMutation(req, {
        resource: 'episode',
        action: 'delete',
        summary: `Deleted episode "${before.episode.title}" (${before.projects.length} storylines)`,
        before,
      });
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
  // Preview exactly what the AI will receive (bible + brief + setting + canon)
  // plus pre-flight checks, before spending an LLM call.
  app.get(
    '/api/episodes/:episodeId/storyline-preview',
    asyncHandler((req, res) => {
      const episode = deps.store.getEpisode(req.params.episodeId);
      res.json({ preview: buildStorylinePreview(deps.store, episode.storyId, episode.id) });
    }),
  );

  // Structural beat sheet for an episode (a planning aid; can feed generation guidance).
  app.post(
    '/api/episodes/:episodeId/beat-sheet',
    asyncHandler(async (req, res) => {
      const episode = deps.store.getEpisode(req.params.episodeId);
      const { model, effort } = req.body ?? {};
      const beats = await generateBeatSheet(deps.store, deps.claude, episode.storyId, episode.id, { model, effort });
      res.json({ beats });
    }),
  );

  app.post(
    '/api/episodes/:episodeId/storylines',
    asyncHandler(async (req, res) => {
      const episode = deps.store.getEpisode(req.params.episodeId);
      const project = await createStorylineProject(deps.store, deps.claude, episode.storyId, episode.id, req.body ?? {});
      res.status(201).json({ project });
    }),
  );

  // Validate every scene against PixVerse rules and estimate render cost before
  // committing credits.
  app.get(
    '/api/storylines/:storylineId/validate',
    asyncHandler((req, res) => {
      res.json({ validation: validateStorylineForRender(deps.store, req.params.storylineId) });
    }),
  );

  // LLM-powered auto-fix: resolve render-parameter issues in a way that best
  // preserves each scene's creative intent (never touches the prompt itself).
  app.post(
    '/api/storylines/:storylineId/autofix',
    asyncHandler(async (req, res) => {
      const { model, effort } = req.body ?? {};
      const result = await autofixStoryline(deps.store, deps.claude, req.params.storylineId, { model, effort });
      res.json({ result, validation: validateStorylineForRender(deps.store, req.params.storylineId) });
    }),
  );

  // Prompt-level continuity QC of a scene against the canon it references.
  app.post(
    '/api/storylines/:storylineId/scenes/:sceneId/qc',
    asyncHandler(async (req, res) => {
      const { model, effort } = req.body ?? {};
      const result = await qcScene(deps.store, deps.claude, req.params.storylineId, req.params.sceneId, { model, effort });
      res.json({ qc: result });
    }),
  );

  // Per-scene dialogue + sound-off captions (planning aid).
  app.post(
    '/api/storylines/:storylineId/dialogue-plan',
    asyncHandler(async (req, res) => {
      const { model, effort } = req.body ?? {};
      const plan = await planStorylineDialogue(deps.store, deps.claude, req.params.storylineId, { model, effort });
      res.json({ plan });
    }),
  );

  // Per-scene SFX cues + overall music direction (planning aid).
  app.post(
    '/api/storylines/:storylineId/sound-plan',
    asyncHandler(async (req, res) => {
      const { model, effort } = req.body ?? {};
      const plan = await planStorylineSound(deps.store, deps.claude, req.params.storylineId, { model, effort });
      res.json({ plan });
    }),
  );

  // "Are we ready to ship?" checklist composing every gate for a storyline.
  app.get(
    '/api/storylines/:storylineId/readiness',
    asyncHandler((req, res) => {
      res.json({ readiness: productionReadiness(deps.store, req.params.storylineId) });
    }),
  );

  // Downloadable subtitle track (.srt) built from each scene's caption + durations.
  app.get(
    '/api/storylines/:storylineId/captions.srt',
    asyncHandler((req, res) => {
      const project = deps.store.getProject(req.params.storylineId);
      const slug = project.storyline.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'storyline';
      res
        .type('application/x-subrip; charset=utf-8')
        .setHeader('Content-Disposition', `attachment; filename="${slug}.srt"`)
        .send(buildCaptionsSrt(deps.store, req.params.storylineId));
    }),
  );

  // Localized subtitle track — translate the captions and return a timed SRT.
  app.post(
    '/api/storylines/:storylineId/captions/localize',
    asyncHandler(async (req, res) => {
      const { language, model, effort } = req.body ?? {};
      const srt = await localizeCaptionsSrt(
        deps.store,
        deps.claude,
        req.params.storylineId,
        typeof language === 'string' ? language : '',
        { model, effort },
      );
      res.json({ srt });
    }),
  );

  // Downloadable per-scene shot manifest (the reproducible production document).
  app.get(
    '/api/storylines/:storylineId/manifest.md',
    asyncHandler((req, res) => {
      const project = deps.store.getProject(req.params.storylineId);
      const slug = project.storyline.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'storyline';
      sendMarkdown(res, `${slug}.manifest.md`, buildShotManifest(deps.store, req.params.storylineId));
    }),
  );

  app.get(
    '/api/storylines/:storylineId',
    asyncHandler((req, res) => {
      res.json({ project: deps.store.getProject(req.params.storylineId) });
    }),
  );

  // Deep-copy a storyline to try variations without touching the original.
  app.post(
    '/api/storylines/:storylineId/duplicate',
    asyncHandler((req, res) => {
      const project = duplicateStoryline(deps.store, req.params.storylineId);
      recordMutation(req, {
        resource: 'storyline',
        action: 'update',
        summary: `Duplicated storyline "${project.storyline.title}"`,
        before: null,
        after: { id: project.storyline.id, title: project.storyline.title },
      });
      res.status(201).json({ project });
    }),
  );

  app.delete(
    '/api/storylines/:storylineId',
    asyncHandler((req, res) => {
      const before = deps.store.getProject(req.params.storylineId);
      deps.store.deleteProject(req.params.storylineId);
      recordMutation(req, {
        resource: 'storyline',
        action: 'delete',
        summary: `Deleted storyline "${before.storyline.title}" (${before.storyline.scenes.length} scenes)`,
        before,
      });
      res.status(204).end();
    }),
  );

  // ---- Scene editing (tweaking) ----
  app.patch(
    '/api/storylines/:storylineId/scenes/:sceneId',
    asyncHandler((req, res) => {
      const original = deps.store
        .getProject(req.params.storylineId)
        .storyline.scenes.find((s) => s.id === req.params.sceneId);
      const before = original ? { ...original } : undefined; // snapshot before in-place mutation
      const project = updateScene(deps.store, req.params.storylineId, req.params.sceneId, req.body ?? {});
      const updated = project.storyline.scenes.find((s) => s.id === req.params.sceneId);
      recordMutation(req, {
        resource: 'scene',
        action: 'update',
        summary: `Edited scene "${updated?.heading ?? req.params.sceneId}"`,
        before,
        after: updated ? { ...updated } : undefined,
      });
      res.json({ project });
    }),
  );

  // ---- Scene review comments ----
  app.post(
    '/api/storylines/:storylineId/scenes/:sceneId/comments',
    asyncHandler((req, res) => {
      const project = addSceneComment(deps.store, req.params.storylineId, req.params.sceneId, req.body?.text ?? '');
      res.status(201).json({ project });
    }),
  );

  app.patch(
    '/api/storylines/:storylineId/scenes/:sceneId/comments/:commentId',
    asyncHandler((req, res) => {
      const project = setSceneCommentResolved(
        deps.store,
        req.params.storylineId,
        req.params.sceneId,
        req.params.commentId,
        req.body?.resolved !== false,
      );
      res.json({ project });
    }),
  );

  app.delete(
    '/api/storylines/:storylineId/scenes/:sceneId/comments/:commentId',
    asyncHandler((req, res) => {
      const project = deleteSceneComment(deps.store, req.params.storylineId, req.params.sceneId, req.params.commentId);
      res.json({ project });
    }),
  );

  // Directed "change one thing, preserve everything else" edit to a scene's prompt.
  app.post(
    '/api/storylines/:storylineId/scenes/:sceneId/patch',
    asyncHandler(async (req, res) => {
      const { request: changeRequest, model, effort } = req.body ?? {};
      const before = deps.store
        .getProject(req.params.storylineId)
        .storyline.scenes.find((s) => s.id === req.params.sceneId);
      const result = await patchScene(
        deps.store,
        deps.claude,
        req.params.storylineId,
        req.params.sceneId,
        typeof changeRequest === 'string' ? changeRequest : '',
        { model, effort },
      );
      recordMutation(req, {
        resource: 'scene-patch',
        action: 'update',
        summary: `Patched scene "${before?.heading ?? req.params.sceneId}": ${result.patch.changed}`,
        before: { prompt: result.patch.before },
        after: { prompt: result.patch.after },
      });
      res.json({ project: result.project, patch: result.patch });
    }),
  );

  app.post(
    '/api/storylines/:storylineId/scenes/:sceneId/duplicate',
    asyncHandler((req, res) => {
      const project = duplicateScene(deps.store, req.params.storylineId, req.params.sceneId);
      res.status(201).json({ project });
    }),
  );

  app.post(
    '/api/storylines/:storylineId/scenes',
    asyncHandler((req, res) => {
      const project = addScene(deps.store, req.params.storylineId, req.body ?? {});
      const added = project.storyline.scenes[project.storyline.scenes.length - 1];
      recordMutation(req, {
        resource: 'scene',
        action: 'update',
        summary: `Added scene "${added?.heading ?? ''}"`,
        before: null,
        after: added ? { ...added } : null,
      });
      res.status(201).json({ project });
    }),
  );

  // Apply one set of render defaults (aspect ratio, quality, …) to every scene.
  app.post(
    '/api/storylines/:storylineId/scene-defaults',
    asyncHandler((req, res) => {
      const before = deps.store.getProject(req.params.storylineId).storyline.scenes.map((s) => ({ ...s }));
      const result = applySceneDefaults(deps.store, req.params.storylineId, req.body ?? {});
      recordMutation(req, {
        resource: 'scene-defaults',
        action: 'update',
        summary: `Applied ${result.fields.join(', ')} to ${result.applied.length} scene(s)`,
        before,
        after: result.project.storyline.scenes.map((s) => ({ ...s })),
      });
      res.json({
        project: result.project,
        applied: result.applied,
        skipped: result.skipped,
        fields: result.fields,
      });
    }),
  );

  app.delete(
    '/api/storylines/:storylineId/scenes/:sceneId',
    asyncHandler((req, res) => {
      const before = deps.store
        .getProject(req.params.storylineId)
        .storyline.scenes.find((s) => s.id === req.params.sceneId);
      const project = removeScene(deps.store, req.params.storylineId, req.params.sceneId);
      recordMutation(req, {
        resource: 'scene',
        action: 'delete',
        summary: `Deleted scene "${before?.heading ?? req.params.sceneId}"`,
        before,
      });
      res.json({ project });
    }),
  );

  // Which characters/locations the storyline references, and whether each has an
  // approved reference image — the data behind the pre-render approval gate.
  app.get(
    '/api/storylines/:storylineId/reference-readiness',
    asyncHandler((req, res) => {
      res.json({ readiness: referenceReadiness(deps.store, req.params.storylineId) });
    }),
  );

  app.post(
    '/api/storylines/:storylineId/reorder',
    asyncHandler((req, res) => {
      const orderedIds = req.body?.orderedIds;
      if (!Array.isArray(orderedIds)) throw new HttpError(400, 'orderedIds (array) is required');
      const beforeOrder = deps.store.getProject(req.params.storylineId).storyline.scenes.map((s) => s.id);
      const project = reorderScenes(deps.store, req.params.storylineId, orderedIds);
      recordMutation(req, {
        resource: 'scene-order',
        action: 'update',
        summary: 'Reordered scenes',
        before: beforeOrder,
        after: project.storyline.scenes.map((s) => s.id),
      });
      res.json({ project });
    }),
  );

  // A/B title options for the Short (preview; the user picks one to apply).
  app.post(
    '/api/storylines/:storylineId/youtube/title-variants',
    asyncHandler(async (req, res) => {
      const { count, model, effort } = req.body ?? {};
      const variants = await suggestTitleVariants(deps.store, deps.claude, req.params.storylineId, {
        count: count == null ? undefined : Number(count),
        model,
        effort,
      });
      res.json({ variants });
    }),
  );

  // A/B thumbnail concepts (overlay text + framing + which scene) for the Short.
  app.post(
    '/api/storylines/:storylineId/youtube/thumbnail-concepts',
    asyncHandler(async (req, res) => {
      const { count, model, effort } = req.body ?? {};
      const concepts = await suggestThumbnailConcepts(deps.store, deps.claude, req.params.storylineId, {
        count: count == null ? undefined : Number(count),
        model,
        effort,
      });
      res.json({ concepts });
    }),
  );

  // Localize the YouTube metadata into another language (returns a preview; not persisted).
  app.post(
    '/api/storylines/:storylineId/youtube/localize',
    asyncHandler(async (req, res) => {
      const { language, model, effort } = req.body ?? {};
      const youtube = await localizeYoutubeMeta(
        deps.store,
        deps.claude,
        req.params.storylineId,
        typeof language === 'string' ? language : '',
        { model, effort },
      );
      res.json({ youtube });
    }),
  );

  // Editorial review sign-off for a storyline (distinct from per-clip approval).
  app.patch(
    '/api/storylines/:storylineId/review',
    asyncHandler((req, res) => {
      const { status, note } = req.body ?? {};
      const allowed = ['draft', 'in_review', 'approved', 'changes_requested'];
      if (status !== undefined && !allowed.includes(status)) {
        throw new HttpError(400, `status must be one of ${allowed.join(', ')}`);
      }
      const project = deps.store.getProject(req.params.storylineId);
      const before = { reviewStatus: project.storyline.reviewStatus ?? 'draft', reviewNote: project.storyline.reviewNote ?? '' };
      if (status !== undefined) project.storyline.reviewStatus = status;
      if (typeof note === 'string') project.storyline.reviewNote = note;
      project.storyline.updatedAt = new Date().toISOString();
      deps.store.saveProject(project);
      recordMutation(req, {
        resource: 'review',
        action: 'update',
        summary: `Review → ${project.storyline.reviewStatus ?? 'draft'}`,
        before,
        after: { reviewStatus: project.storyline.reviewStatus, reviewNote: project.storyline.reviewNote ?? '' },
      });
      res.json({ project });
    }),
  );

  app.patch(
    '/api/storylines/:storylineId/youtube',
    asyncHandler((req, res) => {
      const before = deps.store.getProject(req.params.storylineId).storyline.youtube;
      const project = updateYoutubeMeta(deps.store, req.params.storylineId, req.body ?? {});
      recordMutation(req, {
        resource: 'youtube',
        action: 'update',
        summary: 'Edited YouTube metadata',
        before,
        after: project.storyline.youtube,
      });
      res.json({ project });
    }),
  );

  // ---- Rendering (PixVerse) ----
  // Async submits (wait:false) return immediately; the JobRunner completes them
  // server-side, so the render finishes even if the browser tab is closed.
  const trackClipIfPending = (storylineId: string, clip: { sceneId: string; status: string; videoId: number | null }) => {
    if (clip.status === 'generating' && clip.videoId != null) {
      jobs.track({ kind: 'clip', storylineId, sceneId: clip.sceneId });
    }
  };

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
      trackClipIfPending(req.params.storylineId, clip);
      res.json({ clip });
    }),
  );

  app.post(
    '/api/storylines/:storylineId/generate',
    asyncHandler(async (req, res) => {
      const project = await generateAllClips(deps.store, deps.pixverse, req.params.storylineId, genOpts(req.body ?? {}));
      for (const clip of Object.values(project.clips)) trackClipIfPending(req.params.storylineId, clip);
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

  // Re-submit every failed / moderation-failed clip (async into the JobRunner).
  app.post(
    '/api/storylines/:storylineId/retry-failed',
    asyncHandler(async (req, res) => {
      const project = deps.store.getProject(req.params.storylineId);
      const failedSceneIds = Object.values(project.clips)
        .filter((c) => c.status === 'failed' || c.status === 'moderation_failed')
        .map((c) => c.sceneId);
      for (const sceneId of failedSceneIds) {
        const clip = await generateClip(deps.store, deps.pixverse, req.params.storylineId, sceneId, genOpts({ wait: false }));
        trackClipIfPending(req.params.storylineId, clip);
      }
      res.json({ project: deps.store.getProject(req.params.storylineId), retried: failedSceneIds.length });
    }),
  );

  // Human sign-off on a rendered clip — the publish gate.
  app.post(
    '/api/storylines/:storylineId/scenes/:sceneId/clip/approval',
    asyncHandler((req, res) => {
      const approved = req.body?.approved !== false;
      const clip = setClipApproval(deps.store, req.params.storylineId, req.params.sceneId, approved);
      recordMutation(req, {
        resource: 'clip-approval',
        action: 'update',
        summary: `${approved ? 'Approved' : 'Unapproved'} clip for scene ${req.params.sceneId}`,
        before: { approved: !approved },
        after: { approved },
      });
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
      trackClipIfPending(req.params.storylineId, clip);
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
      // The app enforces the approval gate; the service default stays permissive.
      const record = await publishProject(deps.store, deps.youtube, req.params.storylineId, {
        ...(req.body ?? {}),
        requireApproval: (req.body ?? {}).requireApproval !== false,
      });
      recordMutation(req, {
        resource: 'publish',
        action: 'update',
        summary: `Published to ${record.provider} (${record.status}${record.dryRun ? ', dry-run' : ''})`,
        before: null,
        after: record,
      });
      res.json({ publish: record });
    }),
  );

  // Schedule a publish for a future time (fires server-side; requires approved clips then).
  app.post(
    '/api/storylines/:storylineId/publish/schedule',
    asyncHandler((req, res) => {
      const { at, privacyStatus, stitch } = req.body ?? {};
      if (!at || typeof at !== 'string') throw new HttpError(400, 'at (ISO timestamp) is required');
      const project = schedulePublish(deps.store, req.params.storylineId, { at, privacyStatus, stitch });
      recordMutation(req, {
        resource: 'publish-schedule',
        action: 'update',
        summary: `Scheduled publish for ${new Date(at).toISOString()}`,
        before: null,
        after: project.schedule,
      });
      res.status(201).json({ schedule: project.schedule });
    }),
  );

  app.delete(
    '/api/storylines/:storylineId/publish/schedule',
    asyncHandler((req, res) => {
      const project = cancelSchedule(deps.store, req.params.storylineId);
      res.json({ schedule: project.schedule });
    }),
  );

  // Record real-world performance for a published short (manual entry; future: analytics sync).
  app.patch(
    '/api/storylines/:storylineId/performance',
    asyncHandler((req, res) => {
      const { views, retentionPct, likes, note } = req.body ?? {};
      if (views != null && !Number.isFinite(Number(views))) throw new HttpError(400, 'views must be a number');
      const project = deps.store.getProject(req.params.storylineId);
      const before = project.performance ?? null;
      project.performance = {
        views: views == null ? (before?.views ?? 0) : Number(views),
        retentionPct: retentionPct == null ? (before?.retentionPct ?? null) : Number(retentionPct),
        likes: likes == null ? (before?.likes ?? null) : Number(likes),
        note: typeof note === 'string' ? note : (before?.note ?? ''),
        recordedAt: new Date().toISOString(),
      };
      deps.store.saveProject(project);
      recordMutation(req, {
        resource: 'performance',
        action: 'update',
        summary: `Recorded performance (${project.performance.views} views)`,
        before,
        after: project.performance,
      });
      res.json({ performance: project.performance });
    }),
  );

  // Schedule a full render run for a future time (fires server-side into the JobRunner).
  app.post(
    '/api/storylines/:storylineId/render/schedule',
    asyncHandler((req, res) => {
      const { at } = req.body ?? {};
      if (!at || typeof at !== 'string') throw new HttpError(400, 'at (ISO timestamp) is required');
      const project = scheduleRender(deps.store, req.params.storylineId, at);
      recordMutation(req, {
        resource: 'render-schedule',
        action: 'update',
        summary: `Scheduled render for ${new Date(at).toISOString()}`,
        before: null,
        after: project.renderSchedule,
      });
      res.status(201).json({ renderSchedule: project.renderSchedule });
    }),
  );

  app.delete(
    '/api/storylines/:storylineId/render/schedule',
    asyncHandler((req, res) => {
      const project = cancelRenderSchedule(deps.store, req.params.storylineId);
      res.json({ renderSchedule: project.renderSchedule });
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
  if (err instanceof UserInputError) return { status: 400, body: { error: err.message } };
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
