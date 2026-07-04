import type {
  AppConfig,
  AuditEvent,
  CanonRegistry,
  CharacterAsset,
  EpisodeIdea,
  CharacterRegistry,
  Clip,
  CostLineItem,
  CostReport,
  Job,
  DriftFinding,
  DriftReport,
  Episode,
  EventService,
  EventStatus,
  PortraitVersion,
  Project,
  ProjectSummary,
  AutofixResult,
  CanonDiff,
  ReferenceDefinition,
  ReferenceReadiness,
  RenderValidation,
  Scene,
  SceneDefaultsResult,
  ScenePatch,
  Story,
  StoryMeta,
  StorylinePreview,
  YoutubeMeta,
} from './types';

async function req<T>(method: string, url: string, body?: unknown, opts?: { signal?: AbortSignal }): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: opts?.signal,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const message = json?.error ?? `HTTP ${res.status}`;
    const issues = json?.issues ? ` (${json.issues.join(' ')})` : '';
    throw new Error(message + issues);
  }
  return json as T;
}

export const api = {
  config: () => req<AppConfig>('GET', '/api/config'),

  listStories: () => req<{ stories: Story[] }>('GET', '/api/stories'),
  createStory: (data: { title: string; settingMode?: string; bible?: string }) =>
    req<{ story: Story }>('POST', '/api/stories', data),
  getStory: (id: string) => req<{ story: Story; bible: string; episodes: Episode[] }>('GET', `/api/stories/${id}`),
  updateStory: (id: string, patch: { title?: string; settingMode?: string; continuity?: string; meta?: Partial<StoryMeta> }) =>
    req<{ story: Story }>('PATCH', `/api/stories/${id}`, patch),
  deleteStory: (id: string) => req<void>('DELETE', `/api/stories/${id}`),
  setBible: (id: string, markdown: string) => req<{ markdown: string }>('PUT', `/api/stories/${id}/bible`, { markdown }),

  createEpisode: (storyId: string, data: { title: string; brief?: string; setting?: string }) =>
    req<{ episode: Episode }>('POST', `/api/stories/${storyId}/episodes`, data),
  getEpisode: (id: string) =>
    req<{ episode: Episode; setting: string; projects: ProjectSummary[] }>('GET', `/api/episodes/${id}`),
  updateEpisode: (id: string, patch: { title?: string; brief?: string; runtimeSec?: number | null }) =>
    req<{ episode: Episode }>('PATCH', `/api/episodes/${id}`, patch),
  deleteEpisode: (id: string) => req<void>('DELETE', `/api/episodes/${id}`),
  setSetting: (id: string, markdown: string) =>
    req<{ markdown: string }>('PUT', `/api/episodes/${id}/setting`, { markdown }),

  createStoryline: (episodeId: string, opts: Record<string, unknown> & { signal?: AbortSignal }) => {
    const { signal, ...body } = opts;
    return req<{ project: Project }>('POST', `/api/episodes/${episodeId}/storylines`, body, { signal });
  },
  getProject: (storylineId: string) => req<{ project: Project }>('GET', `/api/storylines/${storylineId}`),
  deleteProject: (storylineId: string) => req<void>('DELETE', `/api/storylines/${storylineId}`),

  updateScene: (storylineId: string, sceneId: string, patch: Partial<Scene>) =>
    req<{ project: Project }>('PATCH', `/api/storylines/${storylineId}/scenes/${sceneId}`, patch),
  addScene: (storylineId: string, partial?: Partial<Scene>) =>
    req<{ project: Project }>('POST', `/api/storylines/${storylineId}/scenes`, partial ?? {}),
  patchScene: (storylineId: string, sceneId: string, request: string, opts: { model?: string } = {}) =>
    req<{ project: Project; patch: ScenePatch }>(
      'POST',
      `/api/storylines/${storylineId}/scenes/${sceneId}/patch`,
      { request, ...opts },
    ),
  removeScene: (storylineId: string, sceneId: string) =>
    req<{ project: Project }>('DELETE', `/api/storylines/${storylineId}/scenes/${sceneId}`),
  reorder: (storylineId: string, orderedIds: string[]) =>
    req<{ project: Project }>('POST', `/api/storylines/${storylineId}/reorder`, { orderedIds }),
  updateYoutube: (storylineId: string, patch: Partial<YoutubeMeta>) =>
    req<{ project: Project }>('PATCH', `/api/storylines/${storylineId}/youtube`, patch),

  generateScene: (storylineId: string, sceneId: string, wait = true) =>
    req<{ clip: Clip }>('POST', `/api/storylines/${storylineId}/scenes/${sceneId}/generate`, { wait }),
  refreshScene: (storylineId: string, sceneId: string) =>
    req<{ clip: Clip }>('POST', `/api/storylines/${storylineId}/scenes/${sceneId}/refresh`),
  approveClip: (storylineId: string, sceneId: string, approved: boolean) =>
    req<{ clip: Clip }>('POST', `/api/storylines/${storylineId}/scenes/${sceneId}/clip/approval`, { approved }),
  extendScene: (storylineId: string, sceneId: string, wait = true) =>
    req<{ clip: Clip }>('POST', `/api/storylines/${storylineId}/scenes/${sceneId}/extend`, { wait }),
  generateAll: (storylineId: string, wait = true) =>
    req<{ project: Project }>('POST', `/api/storylines/${storylineId}/generate`, { wait }),
  uploadImage: (storylineId: string, sceneId: string, data: { dataBase64: string; contentType: string; filename: string }) =>
    req<{ project: Project }>('POST', `/api/storylines/${storylineId}/scenes/${sceneId}/image`, data),

  publish: (storylineId: string, opts: Record<string, unknown>) =>
    req<{ publish: PublishResult }>('POST', `/api/storylines/${storylineId}/publish`, opts),

  // ---- Canon & drift ----
  getCanon: (storyId: string) => req<{ registry: CanonRegistry | null }>('GET', `/api/stories/${storyId}/canon`),
  canonDiff: (storyId: string, opts: { from?: number; to?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.from !== undefined) params.set('from', String(opts.from));
    if (opts.to !== undefined) params.set('to', String(opts.to));
    const qs = params.toString();
    return req<{ diff: CanonDiff | null }>('GET', `/api/stories/${storyId}/canon/diff${qs ? `?${qs}` : ''}`);
  },
  extractCanon: (storyId: string, opts: { model?: string; effort?: string; note?: string }) =>
    req<{ registry: CanonRegistry }>('POST', `/api/stories/${storyId}/canon/extract`, opts),
  patchMark: (
    storyId: string,
    entityId: string,
    markKey: string,
    patch: { value?: string; severity?: string; status?: string; transitionTo?: string; note?: string },
  ) =>
    req<{ registry: CanonRegistry }>(
      'PATCH',
      `/api/stories/${storyId}/canon/entities/${entityId}/marks/${encodeURIComponent(markKey)}`,
      patch,
    ),
  // ---- Character reference images ----
  getCharacters: (storyId: string) => req<{ registry: CharacterRegistry }>('GET', `/api/stories/${storyId}/characters`),
  getReferenceDefinition: (storyId: string, entityId: string) =>
    req<{ definition: ReferenceDefinition }>('GET', `/api/stories/${storyId}/characters/${entityId}/definition`),
  generatePortrait: (
    storyId: string,
    entityId: string,
    opts: {
      source?: string;
      promptOverride?: string;
      model?: string;
      quality?: string;
      aspectRatio?: string;
      /** Attach an image to seed an image-to-video (image-guided) render. */
      dataBase64?: string;
      contentType?: string;
      filename?: string;
      wait?: boolean;
      signal?: AbortSignal;
    } = {},
  ) => {
    const { signal, ...body } = opts;
    return req<{ version: PortraitVersion }>('POST', `/api/stories/${storyId}/characters/${entityId}/portraits`, body, {
      signal,
    });
  },
  refreshPortrait: (storyId: string, entityId: string, versionId: string) =>
    req<{ version: PortraitVersion }>(
      'POST',
      `/api/stories/${storyId}/characters/${entityId}/portraits/${versionId}/refresh`,
    ),
  approvePortrait: (storyId: string, entityId: string, versionId: string) =>
    req<{ asset: CharacterAsset }>(
      'POST',
      `/api/stories/${storyId}/characters/${entityId}/portraits/${versionId}/approve`,
    ),
  uploadStill: (storyId: string, entityId: string, data: { dataBase64: string; contentType: string; filename: string }) =>
    req<{ version: PortraitVersion }>('POST', `/api/stories/${storyId}/characters/${entityId}/still`, data),

  driftCheck: (storylineId: string, opts: { model?: string; signal?: AbortSignal } = {}) => {
    const { signal, ...body } = opts;
    return req<{ report: DriftReport }>('POST', `/api/storylines/${storylineId}/drift-check`, body, { signal });
  },
  resolveDrift: (storylineId: string, reportId: string, findingId: string, action: string, note?: string) =>
    req<{ finding: DriftFinding; registry: CanonRegistry | null }>(
      'POST',
      `/api/storylines/${storylineId}/drift/${reportId}/findings/${findingId}/resolve`,
      { action, note },
    ),
  planStory: (storyId: string, opts: { episodeCount: number; model?: string; replace?: boolean }) =>
    req<{ story: Story }>('POST', `/api/stories/${storyId}/plan`, opts),
  extendPlan: (storyId: string, opts: { additionalEpisodes: number; model?: string }) =>
    req<{ story: Story }>('POST', `/api/stories/${storyId}/plan/extend`, opts),
  generateEpisode: (storyId: string, opts: { runtimeSec?: number; model?: string; guidance?: string } = {}) =>
    req<{ episode: Episode; story: Story }>('POST', `/api/stories/${storyId}/episodes/generate`, opts),
  bootstrapStory: (idea: string, opts: { model?: string; withCanon?: boolean; signal?: AbortSignal } = {}) => {
    const { signal, ...rest } = opts;
    return req<{ story: Story; registry: CanonRegistry | null }>('POST', '/api/stories/bootstrap', { idea, ...rest }, { signal });
  },
  suggestEpisodeIdeas: (storyId: string, opts: { count?: number; model?: string } = {}) =>
    req<{ ideas: EpisodeIdea[] }>('POST', `/api/stories/${storyId}/episode-ideas`, opts),
  draftEpisode: (storyId: string, idea: string, opts: { model?: string } = {}) =>
    req<{ draft: { title: string; brief: string; setting: string } }>(
      'POST',
      `/api/stories/${storyId}/episodes/draft`,
      { idea, ...opts },
    ),
  exportStory: async (storyId: string): Promise<{ markdown: string; filename: string }> => {
    const res = await fetch(`/api/stories/${storyId}/export`);
    if (!res.ok) throw new Error(`Export failed (HTTP ${res.status})`);
    const disposition = res.headers.get('content-disposition') ?? '';
    const match = disposition.match(/filename="([^"]+)"/);
    return { markdown: await res.text(), filename: match?.[1] ?? 'story.story.md' };
  },
  importStory: (markdown: string) =>
    req<{ story: Story; episodeCount: number; storylineCount: number; canonVersions: number }>(
      'POST',
      '/api/stories/import',
      { markdown },
    ),
  storyBibleTemplate: (title: string) =>
    req<{ markdown: string }>('GET', `/api/templates/story-bible?title=${encodeURIComponent(title)}`),
  episodeSettingTemplate: (title: string) =>
    req<{ markdown: string }>('GET', `/api/templates/episode-setting?title=${encodeURIComponent(title)}`),

  // ---- Audit events ----
  listEvents: (opts: { q?: string; service?: EventService; status?: EventStatus; before?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.q) params.set('q', opts.q);
    if (opts.service) params.set('service', opts.service);
    if (opts.status) params.set('status', opts.status);
    if (opts.before) params.set('before', opts.before);
    if (opts.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return req<{ events: AuditEvent[]; hasMore: boolean }>('GET', `/api/events${qs ? `?${qs}` : ''}`);
  },
  getEvent: (id: string) => req<{ event: AuditEvent }>('GET', `/api/events/${id}`),
  jobs: () => req<{ jobs: Job[] }>('GET', '/api/jobs'),
  clearEvents: () => req<void>('DELETE', '/api/events'),
  restoreFromAudit: (eventId: string) =>
    req<{ restored: { kind: string; id: string; label: string } }>('POST', `/api/audit/${eventId}/restore`),

  // ---- Costs, preview & validation ----
  costReport: (opts: { storyId?: string; episodeId?: string; since?: string } = {}) => {
    const params = new URLSearchParams();
    if (opts.storyId) params.set('storyId', opts.storyId);
    if (opts.episodeId) params.set('episodeId', opts.episodeId);
    if (opts.since) params.set('since', opts.since);
    const qs = params.toString();
    return req<{ report: CostReport }>('GET', `/api/costs/report${qs ? `?${qs}` : ''}`);
  },
  costEvents: (opts: { storyId?: string; episodeId?: string; since?: string } = {}) => {
    const params = new URLSearchParams();
    if (opts.storyId) params.set('storyId', opts.storyId);
    if (opts.episodeId) params.set('episodeId', opts.episodeId);
    if (opts.since) params.set('since', opts.since);
    const qs = params.toString();
    return req<{ items: CostLineItem[] }>('GET', `/api/costs/events${qs ? `?${qs}` : ''}`);
  },
  storylinePreview: (episodeId: string) =>
    req<{ preview: StorylinePreview }>('GET', `/api/episodes/${episodeId}/storyline-preview`),
  validateStoryline: (storylineId: string) =>
    req<{ validation: RenderValidation }>('GET', `/api/storylines/${storylineId}/validate`),
  autofixStoryline: (storylineId: string, opts: { model?: string; signal?: AbortSignal } = {}) => {
    const { signal, ...body } = opts;
    return req<{ result: AutofixResult; validation: RenderValidation }>(
      'POST',
      `/api/storylines/${storylineId}/autofix`,
      body,
      { signal },
    );
  },
  referenceReadiness: (storylineId: string) =>
    req<{ readiness: ReferenceReadiness }>('GET', `/api/storylines/${storylineId}/reference-readiness`),
  applySceneDefaults: (storylineId: string, defaults: SceneDefaults) =>
    req<SceneDefaultsResult>('POST', `/api/storylines/${storylineId}/scene-defaults`, defaults),
};

/** Render parameters that can be applied to every scene at once. */
export interface SceneDefaults {
  aspectRatio?: string;
  quality?: string;
  model?: string;
  motionMode?: string;
  style?: string;
  cameraMovement?: string;
}

interface PublishResult {
  status: string;
  dryRun: boolean;
  videoId: string | null;
  url: string | null;
  error: string | null;
}
