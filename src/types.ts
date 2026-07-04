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
  /** Canon character entity ids whose approved reference images this scene uses. */
  referenceCharacterIds?: string[];
  /** Directed "change one thing" edits applied to this scene's prompt, newest last. */
  patchHistory?: ScenePatch[];
  /** Review notes on this scene (does not affect the render). */
  comments?: SceneComment[];
}

export interface SceneComment {
  id: string;
  text: string;
  resolved: boolean;
  createdAt: string;
}

/** A named, studio-wide set of render defaults, applied across scenes/stories. */
export interface RenderPreset {
  id: string;
  name: string;
  aspectRatio?: string;
  quality?: string;
  model?: string;
  motionMode?: string;
  style?: string;
  cameraMovement?: string;
  createdAt: string;
}

/**
 * A single directed patch to a scene's prompt: the operator asked for one change
 * ("make Bobo look worried") and the model rewrote only that, preserving
 * everything else — the "locked by default" edit. Kept as history so edits are
 * auditable and reversible.
 */
export interface ScenePatch {
  id: string;
  request: string;
  before: string;
  after: string;
  changed: string;
  preserved: string[];
  rationale: string;
  model: string;
  createdAt: string;
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
  /** Human sign-off that this rendered clip is final. Publishing requires it. Reset on any re-render/edit. */
  approved?: boolean;
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

export interface PublishSchedule {
  /** ISO timestamp at/after which the scheduled publish should fire. */
  at: string;
  privacyStatus?: 'public' | 'unlisted' | 'private';
  stitch?: boolean;
  status: 'pending' | 'published' | 'failed' | 'cancelled';
  error: string | null;
  createdAt: string;
}

/** Top-level project record aggregating a storyline, its clips, and publish state. */
export interface Project {
  storyline: Storyline;
  clips: Record<string, Clip>;
  /** Most recent publish attempt (null until first publish). */
  publish: PublishRecord | null;
  /** Every publish attempt, newest last — the publish history. */
  publishHistory?: PublishRecord[];
  /** Consistency (drift) reports run against this storyline. */
  driftReports?: DriftReport[];
  /** A pending/queued scheduled publish, if any. */
  schedule?: PublishSchedule | null;
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
// Character reference images (versioned portraits attached to scenes)
// ---------------------------------------------------------------------------

export type PortraitStatus = 'generating' | 'ready' | 'failed' | 'moderation_failed';

export type PortraitSource = 'auto' | 'refresh' | 'tweak' | 'upload';

/** One version of a character's reference image. Every refresh/tweak = a new version. */
export interface PortraitVersion {
  id: string;
  version: number;
  /** The prompt used to render this portrait (editable via "tweak"). */
  prompt: string;
  negativePrompt: string;
  model: string;
  quality: string;
  aspectRatio: string;
  style: string;
  source: PortraitSource;
  status: PortraitStatus;
  /** PixVerse video id of the rendered portrait clip (when generated). */
  videoId: number | null;
  /** Rendered portrait preview (the portrait clip URL). */
  previewUrl: string | null;
  /** Uploaded still that PixVerse can consume as an image-to-video source. */
  imageId: number | null;
  imageUrl: string | null;
  /** Why no still image was captured/uploaded for an otherwise-ready render (null when one exists or wasn't attempted). */
  imageError: string | null;
  /** When this render was seeded from an input image (image-to-video tweak), the URL of that source image. */
  sourceImageUrl: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** What kind of canon entity this reference-image asset renders. */
export type ReferenceAssetType = 'character' | 'location';

/** All reference-image versions for one canon character or location, plus the approved pick. */
export interface CharacterAsset {
  /** Canon entity id, e.g. CHAR_BOBO_001 or LOC_GIGGLE_TREE_001. */
  entityId: string;
  type: ReferenceAssetType;
  name: string;
  approvedVersionId: string | null;
  versions: PortraitVersion[];
}

export interface CharacterRegistry {
  storyId: string;
  characters: Record<string, CharacterAsset>;
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
  /** consistency = a canon/continuity break; safety = a tone or audience-appropriateness concern. */
  category: 'consistency' | 'safety';
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
