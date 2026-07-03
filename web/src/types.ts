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
  dissect: { models: string[]; defaultModel: string };
}

export interface StoryMeta {
  audienceMin: number | null;
  audienceMax: number | null;
  audienceNotes: string;
  genres: string[];
  tones: string[];
  format: string;
  episodeLengthSec: number | null;
  language: string;
}

export interface Story {
  id: string;
  title: string;
  slug: string;
  settingMode: 'shared' | 'per-episode';
  meta: StoryMeta;
  createdAt: string;
  updatedAt: string;
}

// ---- Canon & drift ----

export type MarkSeverity = 'locked' | 'strong' | 'flexible';

export interface ConsistencyMark {
  key: string;
  value: string;
  severity: MarkSeverity;
  status: 'active' | 'transitioning';
  transition: { from: string; to: string; startedAt: string; note: string } | null;
  rationale: string;
}

export interface CanonEntity {
  id: string;
  type: string;
  name: string;
  summary: string;
  marks: ConsistencyMark[];
}

export interface CanonVersion {
  version: number;
  createdAt: string;
  source: string;
  model: string | null;
  note: string;
  entities: CanonEntity[];
  negativePrompt: string;
}

export interface CanonRegistry {
  storyId: string;
  currentVersion: number;
  versions: CanonVersion[];
}

export interface DriftFinding {
  id: string;
  entityId: string | null;
  entityName: string;
  markKey: string;
  expected: string;
  observed: string;
  sceneIds: string[];
  severity: 'high' | 'medium' | 'low';
  explanation: string;
  suggestion: string;
  resolution: { action: string; resolvedAt: string; note: string; canonVersion: number | null } | null;
}

export interface DriftReport {
  id: string;
  storylineId: string;
  canonVersion: number;
  model: string;
  createdAt: string;
  summary: string;
  findings: DriftFinding[];
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
  canonVersion?: number | null;
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
  driftReports?: DriftReport[];
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
