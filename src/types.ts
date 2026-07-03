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

/** Production metadata used to steer storyline generation and canon marks. */
export interface StoryMeta {
  /** Target audience age range, e.g. 4–7. Null = unspecified. */
  audienceMin: number | null;
  audienceMax: number | null;
  audienceNotes: string;
  /** e.g. ["comedy", "sci-fi", "adventure"] */
  genres: string[];
  /** e.g. ["cheerful", "warm", "safe"] */
  tones: string[];
  /** e.g. "3D animated comedy shorts" */
  format: string;
  /** Target episode length in seconds (Shorts ≈ 60). */
  episodeLengthSec: number | null;
  language: string;
}

export function defaultStoryMeta(): StoryMeta {
  return {
    audienceMin: null,
    audienceMax: null,
    audienceNotes: '',
    genres: [],
    tones: [],
    format: '',
    episodeLengthSec: 60,
    language: 'English',
  };
}

/**
 * How episodes relate to each other:
 * - random: standalone episodes reusing the canon; the series can run forever.
 * - linear: serialized — episodes follow a planned season arc to an ending.
 */
export type StoryContinuity = 'random' | 'linear';

/** One episode slot in a linear season plan. */
export interface PlannedEpisode {
  number: number;
  title: string;
  synopsis: string;
  /** What this episode contributes to the overall arc. */
  arcNote: string;
  /** Set once the episode has actually been created. */
  episodeId: string | null;
}

/** The season arc for a linear story (extendable). */
export interface StoryPlan {
  arcSummary: string;
  finale: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  episodes: PlannedEpisode[];
}

export interface Story {
  id: string;
  title: string;
  slug: string;
  settingMode: SettingMode;
  continuity: StoryContinuity;
  plan: StoryPlan | null;
  meta: StoryMeta;
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
  /** Target runtime in seconds (null = use the story's default). */
  runtimeSec: number | null;
  /** For linear stories: which planned episode slot this fulfils. */
  plannedNumber: number | null;
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
  /** Canon version this storyline was generated against (null = no canon yet). */
  canonVersion?: number | null;
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
  /** Consistency (drift) reports run against this storyline. */
  driftReports?: DriftReport[];
}

// ---------------------------------------------------------------------------
// Canon registry — version-controlled consistency marks extracted from bibles
// ---------------------------------------------------------------------------

export type CanonEntityType =
  | 'character'
  | 'location'
  | 'prop'
  | 'relationship'
  | 'world_rule'
  | 'visual_style'
  | 'audience_tone';

/** How strictly a mark must be preserved across episodes. */
export type MarkSeverity = 'locked' | 'strong' | 'flexible';

export interface MarkTransition {
  /** The previous canonical value we are moving away from. */
  from: string;
  /** The new value future storylines should gradually adopt. */
  to: string;
  startedAt: string;
  note: string;
}

/** A single fact that must stay consistent (e.g. "scarf: bright green leaf scarf"). */
export interface ConsistencyMark {
  key: string;
  value: string;
  severity: MarkSeverity;
  status: 'active' | 'transitioning';
  transition: MarkTransition | null;
  rationale: string;
}

export interface CanonEntity {
  /** Stable asset id, e.g. CHAR_BOBO_001, LOC_GIGGLE_TREE_002. */
  id: string;
  type: CanonEntityType;
  name: string;
  summary: string;
  marks: ConsistencyMark[];
}

export interface CanonVersion {
  version: number;
  createdAt: string;
  source: 'extraction' | 'manual' | 'drift-acceptance';
  /** Claude model used (null for manual edits). */
  model: string | null;
  note: string;
  entities: CanonEntity[];
  /** Global avoid-list merged into every scene's negative prompt. */
  negativePrompt: string;
}

export interface CanonRegistry {
  storyId: string;
  currentVersion: number;
  versions: CanonVersion[];
}

// ---------------------------------------------------------------------------
// Drift detection — warnings when a storyline diverges from canon
// ---------------------------------------------------------------------------

export type DriftSeverity = 'high' | 'medium' | 'low';

export type DriftResolutionAction = 'accept-now' | 'accept-gradually' | 'reject';

export interface DriftResolution {
  action: DriftResolutionAction;
  resolvedAt: string;
  note: string;
  /** Canon version created by an acceptance (null for reject). */
  canonVersion: number | null;
}

export interface DriftFinding {
  id: string;
  entityId: string | null;
  entityName: string;
  markKey: string;
  expected: string;
  observed: string;
  sceneIds: string[];
  severity: DriftSeverity;
  explanation: string;
  suggestion: string;
  resolution: DriftResolution | null;
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
