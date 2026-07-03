export interface ClaudeModelInfo {
  id: string;
  label: string;
  supportsEffort: boolean;
  maxEffort: string;
}

export interface AppConfig {
  claudeModels: ClaudeModelInfo[];
  efforts: string[];
  pixverse: {
    models: string[];
    qualities: string[];
    durations: number[];
    aspectRatios: string[];
    motionModes: string[];
    styles: string[];
    cameraMovements: string[];
  };
  youtubeDryRun: boolean;
}

export interface Story {
  id: string;
  title: string;
  slug: string;
  settingMode: 'shared' | 'per-episode';
  createdAt: string;
  updatedAt: string;
}

export interface Episode {
  id: string;
  storyId: string;
  title: string;
  brief: string;
  hasSettingOverride: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Scene {
  id: string;
  order: number;
  heading: string;
  description: string;
  prompt: string;
  negativePrompt: string;
  duration: number;
  aspectRatio: string;
  model: string;
  quality: string;
  motionMode: string;
  style: string;
  cameraMovement: string;
  imageId?: number;
  imageUrl?: string;
}

export interface YoutubeMeta {
  title: string;
  description: string;
  tags: string[];
  hashtags: string[];
}

export interface Storyline {
  id: string;
  storyId: string;
  episodeId: string;
  title: string;
  logline: string;
  model: string;
  effort: string | null;
  scenes: Scene[];
  youtube: YoutubeMeta;
  createdAt: string;
  updatedAt: string;
}

export type ClipStatus = 'idle' | 'generating' | 'ready' | 'failed' | 'moderation_failed';

export interface Clip {
  sceneId: string;
  status: ClipStatus;
  videoId: number | null;
  url: string | null;
  error: string | null;
  attempts: unknown[];
  updatedAt: string;
}

export interface PublishRecord {
  status: 'unpublished' | 'publishing' | 'published' | 'failed';
  provider: 'youtube';
  dryRun: boolean;
  videoId: string | null;
  url: string | null;
  error: string | null;
  publishedAt: string | null;
}

export interface Project {
  storyline: Storyline;
  clips: Record<string, Clip>;
  publish: PublishRecord | null;
}

export interface ProjectSummary {
  storylineId: string;
  title: string;
  model: string;
  effort: string | null;
  sceneCount: number;
  createdAt: string;
  publish: PublishRecord | null;
}
