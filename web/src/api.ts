import type {
  AppConfig,
  CanonRegistry,
  Clip,
  DriftFinding,
  DriftReport,
  Episode,
  Project,
  ProjectSummary,
  Scene,
  Story,
  StoryMeta,
  YoutubeMeta,
} from './types';

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
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
  updateStory: (id: string, patch: { title?: string; settingMode?: string; meta?: Partial<StoryMeta> }) =>
    req<{ story: Story }>('PATCH', `/api/stories/${id}`, patch),
  deleteStory: (id: string) => req<void>('DELETE', `/api/stories/${id}`),
  setBible: (id: string, markdown: string) => req<{ markdown: string }>('PUT', `/api/stories/${id}/bible`, { markdown }),

  createEpisode: (storyId: string, data: { title: string; brief?: string; setting?: string }) =>
    req<{ episode: Episode }>('POST', `/api/stories/${storyId}/episodes`, data),
  getEpisode: (id: string) =>
    req<{ episode: Episode; setting: string; projects: ProjectSummary[] }>('GET', `/api/episodes/${id}`),
  updateEpisode: (id: string, patch: { title?: string; brief?: string }) =>
    req<{ episode: Episode }>('PATCH', `/api/episodes/${id}`, patch),
  deleteEpisode: (id: string) => req<void>('DELETE', `/api/episodes/${id}`),
  setSetting: (id: string, markdown: string) =>
    req<{ markdown: string }>('PUT', `/api/episodes/${id}/setting`, { markdown }),

  createStoryline: (episodeId: string, opts: Record<string, unknown>) =>
    req<{ project: Project }>('POST', `/api/episodes/${episodeId}/storylines`, opts),
  getProject: (storylineId: string) => req<{ project: Project }>('GET', `/api/storylines/${storylineId}`),
  deleteProject: (storylineId: string) => req<void>('DELETE', `/api/storylines/${storylineId}`),

  updateScene: (storylineId: string, sceneId: string, patch: Partial<Scene>) =>
    req<{ project: Project }>('PATCH', `/api/storylines/${storylineId}/scenes/${sceneId}`, patch),
  addScene: (storylineId: string, partial?: Partial<Scene>) =>
    req<{ project: Project }>('POST', `/api/storylines/${storylineId}/scenes`, partial ?? {}),
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
  driftCheck: (storylineId: string, opts: { model?: string } = {}) =>
    req<{ report: DriftReport }>('POST', `/api/storylines/${storylineId}/drift-check`, opts),
  resolveDrift: (storylineId: string, reportId: string, findingId: string, action: string, note?: string) =>
    req<{ finding: DriftFinding; registry: CanonRegistry | null }>(
      'POST',
      `/api/storylines/${storylineId}/drift/${reportId}/findings/${findingId}/resolve`,
      { action, note },
    ),
  storyBibleTemplate: (title: string) =>
    req<{ markdown: string }>('GET', `/api/templates/story-bible?title=${encodeURIComponent(title)}`),
  episodeSettingTemplate: (title: string) =>
    req<{ markdown: string }>('GET', `/api/templates/episode-setting?title=${encodeURIComponent(title)}`),
};

interface PublishResult {
  status: string;
  dryRun: boolean;
  videoId: string | null;
  url: string | null;
  error: string | null;
}
