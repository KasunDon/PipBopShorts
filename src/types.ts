import type {
  ClaudeEffort,
  PixverseAspectRatio,
  PixverseCameraMovement,
  PixverseDuration,
  PixverseModel,
  PixverseMotionMode,
  PixverseQuality,
  PixverseStyle,
} from './constants';

export type SettingMode = 'shared' | 'per-episode';

export interface Story {
  id: string;
  title: string;
  slug: string;
  settingMode: SettingMode;
  createdAt: string;
  updatedAt: string;
}

export interface Episode {
  id: string;
  storyId: string;
  title: string;
  brief: string;
  /** Whether this episode has its own setting bible (per-episode stories). */
  hasSettingOverride: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A single shot the AI proposes; every field maps to PixVerse generation params. */
export interface Scene {
  id: string;
  order: number;
  heading: string;
  description: string;
  prompt: string;
  negativePrompt: string;
  duration: PixverseDuration;
  aspectRatio: PixverseAspectRatio;
  model: PixverseModel;
  quality: PixverseQuality;
  motionMode: PixverseMotionMode;
  style: PixverseStyle;
  cameraMovement: PixverseCameraMovement;
  /** Optional image reference (PixVerse img_id) for image-to-video. */
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
  effort: ClaudeEffort | null;
  scenes: Scene[];
  youtube: YoutubeMeta;
  createdAt: string;
  updatedAt: string;
}

export type ClipStatus = 'idle' | 'generating' | 'ready' | 'failed' | 'moderation_failed';

export interface ClipAttempt {
  videoId: number | null;
  status: ClipStatus;
  url: string | null;
  error: string | null;
  params: Scene;
  startedAt: string;
  finishedAt: string | null;
}

/** The rendered result for a scene, including tweak/regenerate history. */
export interface Clip {
  sceneId: string;
  status: ClipStatus;
  videoId: number | null;
  url: string | null;
  error: string | null;
  attempts: ClipAttempt[];
  updatedAt: string;
}

export type PublishStatus = 'unpublished' | 'publishing' | 'published' | 'failed';

export interface PublishRecord {
  status: PublishStatus;
  provider: 'youtube';
  dryRun: boolean;
  videoId: string | null;
  url: string | null;
  error: string | null;
  publishedAt: string | null;
}

/** Top-level project record aggregating a storyline, its clips, and publish state. */
export interface Project {
  storyline: Storyline;
  clips: Record<string, Clip>;
  publish: PublishRecord | null;
}
