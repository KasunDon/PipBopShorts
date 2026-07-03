/**
 * PixVerse generation parameters and allowed values.
 * Source: https://docs.platform.pixverse.ai/ (openapi/v2).
 */
export const PIXVERSE_MODELS = ['v3.5', 'v4', 'v4.5', 'v5', 'v5.5'] as const;
export type PixverseModel = (typeof PIXVERSE_MODELS)[number];

export const PIXVERSE_QUALITIES = ['360p', '540p', '720p', '1080p'] as const;
export type PixverseQuality = (typeof PIXVERSE_QUALITIES)[number];

export const PIXVERSE_DURATIONS = [5, 8] as const;
export type PixverseDuration = (typeof PIXVERSE_DURATIONS)[number];

export const PIXVERSE_ASPECT_RATIOS = ['16:9', '9:16', '1:1'] as const;
export type PixverseAspectRatio = (typeof PIXVERSE_ASPECT_RATIOS)[number];

export const PIXVERSE_MOTION_MODES = ['normal', 'fast'] as const;
export type PixverseMotionMode = (typeof PIXVERSE_MOTION_MODES)[number];

// 'none' is a UI convenience meaning "no stylization"; it is stripped before the API call.
export const PIXVERSE_STYLES = ['none', 'anime', '3d_animation', 'clay', 'comic', 'cyberpunk'] as const;
export type PixverseStyle = (typeof PIXVERSE_STYLES)[number];

export const PIXVERSE_CAMERA_MOVEMENTS = [
  'none',
  'horizontal_left',
  'horizontal_right',
  'vertical_up',
  'vertical_down',
  'zoom_in',
  'zoom_out',
  'crane_up',
  'quickly_zoom_in',
  'quickly_zoom_out',
  'smooth_zoom_in',
  'camera_rotation',
  'robo_arm',
  'super_dolly_out',
  'whip_pan',
  'hitchcock',
  'left_follow',
  'right_follow',
  'pan_left',
  'pan_right',
  'fix_bg',
] as const;
export type PixverseCameraMovement = (typeof PIXVERSE_CAMERA_MOVEMENTS)[number];

/** PixVerse video generation status codes returned by /video/result/{id}. */
export const PIXVERSE_STATUS = {
  SUCCESS: 1,
  GENERATING: 5,
  DELETED: 6,
  MODERATION_FAILED: 7,
  FAILED: 8,
} as const;

export function describePixverseStatus(status: number): string {
  switch (status) {
    case PIXVERSE_STATUS.SUCCESS:
      return 'succeeded';
    case PIXVERSE_STATUS.GENERATING:
      return 'generating';
    case PIXVERSE_STATUS.DELETED:
      return 'deleted';
    case PIXVERSE_STATUS.MODERATION_FAILED:
      return 'moderation_failed';
    case PIXVERSE_STATUS.FAILED:
      return 'failed';
    default:
      return `unknown(${status})`;
  }
}

/**
 * Claude models offered in the storyline generator, with per-model capabilities.
 * These drive how requests are constructed (thinking, effort, fallbacks).
 */
export interface ClaudeModelInfo {
  id: string;
  label: string;
  /** Supports output_config.effort (low/medium/high/xhigh/max subset). */
  supportsEffort: boolean;
  /** Highest effort level accepted by this model. */
  maxEffort: ClaudeEffort;
  /** How to send the `thinking` parameter. */
  thinking: 'adaptive' | 'always-on' | 'none';
  /** Use the server-side refusal fallback (Fable 5). */
  useFallback: boolean;
}

export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];

export const CLAUDE_MODELS: ClaudeModelInfo[] = [
  {
    id: 'claude-fable-5',
    label: 'Claude Fable 5 (most capable)',
    supportsEffort: true,
    maxEffort: 'max',
    thinking: 'always-on',
    useFallback: true,
  },
  {
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    supportsEffort: true,
    maxEffort: 'max',
    thinking: 'adaptive',
    useFallback: false,
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    supportsEffort: true,
    maxEffort: 'max',
    thinking: 'adaptive',
    useFallback: false,
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5 (fastest)',
    supportsEffort: false,
    maxEffort: 'high',
    thinking: 'none',
    useFallback: false,
  },
];

export function getClaudeModel(id: string): ClaudeModelInfo | undefined {
  return CLAUDE_MODELS.find((m) => m.id === id);
}

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-8';
export const DEFAULT_CLAUDE_EFFORT: ClaudeEffort = 'high';

/** Sensible defaults for a vertical YouTube Short. */
export const SHORT_DEFAULTS = {
  aspectRatio: '9:16' as PixverseAspectRatio,
  model: 'v5' as PixverseModel,
  quality: '540p' as PixverseQuality,
  duration: 5 as PixverseDuration,
  motionMode: 'normal' as PixverseMotionMode,
};
