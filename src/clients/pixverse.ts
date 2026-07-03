import {
  PIXVERSE_ASPECT_RATIOS,
  PIXVERSE_CAMERA_MOVEMENTS,
  PIXVERSE_DURATIONS,
  PIXVERSE_MODELS,
  PIXVERSE_MOTION_MODES,
  PIXVERSE_QUALITIES,
  PIXVERSE_STATUS,
  PIXVERSE_STYLES,
  describePixverseStatus,
  type PixverseAspectRatio,
  type PixverseCameraMovement,
  type PixverseDuration,
  type PixverseModel,
  type PixverseMotionMode,
  type PixverseQuality,
  type PixverseStyle,
} from '../constants';

export interface GenerationParams {
  prompt: string;
  model: PixverseModel;
  quality: PixverseQuality;
  duration: PixverseDuration;
  motionMode: PixverseMotionMode;
  aspectRatio?: PixverseAspectRatio;
  negativePrompt?: string;
  style?: PixverseStyle;
  cameraMovement?: PixverseCameraMovement;
  seed?: number;
  imageId?: number;
}

export interface PixverseVideoResult {
  status: number;
  statusLabel: string;
  url: string | null;
  outputWidth?: number;
  outputHeight?: number;
  resolutionRatio?: string;
  seed?: number;
  prompt?: string;
  raw: Record<string, unknown>;
}

export interface UploadImageResult {
  imgId: number;
  imgUrl: string;
}

/** Error carrying PixVerse's ErrCode/ErrMsg envelope. */
export class PixverseError extends Error {
  constructor(
    message: string,
    readonly errCode?: number,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'PixverseError';
  }
}

/** Thrown when generation parameters fail validation before hitting the API. */
export class ValidationError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

export interface ValidateOptions {
  /** When true, an image reference is required (image-to-video) and prompt may be empty. */
  requireImage?: boolean;
}

/**
 * Validate generation parameters against PixVerse's allowed values and known
 * constraints. Returns a list of human-readable problems (empty = valid).
 */
export function collectValidationIssues(
  params: GenerationParams,
  opts: ValidateOptions = {},
): string[] {
  const issues: string[] = [];

  const hasImage = typeof params.imageId === 'number';
  if (opts.requireImage && !hasImage) {
    issues.push('An image reference (imageId) is required for image-to-video.');
  }
  const promptEmpty = !params.prompt || params.prompt.trim().length === 0;
  if (promptEmpty && !hasImage) {
    issues.push('prompt must not be empty.');
  }
  if (params.prompt && params.prompt.length > 2048) {
    issues.push('prompt must be 2048 characters or fewer.');
  }

  if (!PIXVERSE_MODELS.includes(params.model)) {
    issues.push(`model must be one of ${PIXVERSE_MODELS.join(', ')}.`);
  }
  if (!PIXVERSE_QUALITIES.includes(params.quality)) {
    issues.push(`quality must be one of ${PIXVERSE_QUALITIES.join(', ')}.`);
  }
  if (!PIXVERSE_DURATIONS.includes(params.duration)) {
    issues.push(`duration must be one of ${PIXVERSE_DURATIONS.join(', ')}.`);
  }
  if (!PIXVERSE_MOTION_MODES.includes(params.motionMode)) {
    issues.push(`motionMode must be one of ${PIXVERSE_MOTION_MODES.join(', ')}.`);
  }
  if (params.aspectRatio && !PIXVERSE_ASPECT_RATIOS.includes(params.aspectRatio)) {
    issues.push(`aspectRatio must be one of ${PIXVERSE_ASPECT_RATIOS.join(', ')}.`);
  }
  if (params.style && !PIXVERSE_STYLES.includes(params.style)) {
    issues.push(`style must be one of ${PIXVERSE_STYLES.join(', ')}.`);
  }
  if (params.cameraMovement && !PIXVERSE_CAMERA_MOVEMENTS.includes(params.cameraMovement)) {
    issues.push(`cameraMovement must be one of ${PIXVERSE_CAMERA_MOVEMENTS.join(', ')}.`);
  }

  // Known PixVerse constraint: 1080p renders are capped at 5s.
  if (params.quality === '1080p' && params.duration === 8) {
    issues.push('1080p is limited to a 5-second duration.');
  }
  // Fast motion is only available at the standard 5s duration.
  if (params.motionMode === 'fast' && params.duration === 8) {
    issues.push('fast motion mode is only available for 5-second clips.');
  }
  if (params.seed !== undefined && (!Number.isInteger(params.seed) || params.seed < 0)) {
    issues.push('seed must be a non-negative integer.');
  }

  return issues;
}

export function assertValidGenerationParams(params: GenerationParams, opts: ValidateOptions = {}): void {
  const issues = collectValidationIssues(params, opts);
  if (issues.length > 0) {
    throw new ValidationError(`Invalid generation parameters: ${issues.join(' ')}`, issues);
  }
}

type FetchLike = typeof fetch;

export interface PixverseClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  /** Injectable trace-id generator (UUID per request). */
  traceId?: () => string;
}

interface Envelope<T> {
  ErrCode: number;
  ErrMsg: string;
  Resp: T;
}

/** Strip 'none' sentinel values before sending to the API. */
function cleanStyle(style?: PixverseStyle): string | undefined {
  return style && style !== 'none' ? style : undefined;
}
function cleanCamera(cam?: PixverseCameraMovement): string | undefined {
  return cam && cam !== 'none' ? cam : undefined;
}
function cleanNegative(neg?: string): string | undefined {
  const t = neg?.trim();
  return t ? t : undefined;
}

export class PixverseClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly traceId: () => string;

  constructor(options: PixverseClientOptions) {
    if (!options.apiKey) throw new Error('PixverseClient requires an apiKey');
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'https://app-api.pixverse.ai/openapi/v2').replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.traceId = options.traceId ?? (() => globalThis.crypto.randomUUID());
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'API-KEY': this.apiKey,
      'Ai-trace-id': this.traceId(),
      ...extra,
    };
  }

  private async unwrap<T>(res: Response, context: string): Promise<T> {
    let body: Envelope<T> | undefined;
    const text = await res.text();
    try {
      body = text ? (JSON.parse(text) as Envelope<T>) : undefined;
    } catch {
      throw new PixverseError(`${context}: non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`, undefined, res.status);
    }
    if (!res.ok) {
      throw new PixverseError(
        `${context}: HTTP ${res.status} ${body?.ErrMsg ?? text.slice(0, 200)}`,
        body?.ErrCode,
        res.status,
      );
    }
    if (!body) {
      throw new PixverseError(`${context}: empty response body`, undefined, res.status);
    }
    if (body.ErrCode !== 0) {
      throw new PixverseError(`${context}: ${body.ErrMsg} (ErrCode ${body.ErrCode})`, body.ErrCode, res.status);
    }
    return body.Resp;
  }

  /** Upload an image; returns the img_id to reference in image-to-video. */
  async uploadImage(bytes: Uint8Array, filename = 'image.png', contentType = 'image/png'): Promise<UploadImageResult> {
    const form = new FormData();
    // A fresh copy backs the Blob so it does not alias the caller's buffer.
    form.append('image', new Blob([new Uint8Array(bytes)], { type: contentType }), filename);
    const res = await this.fetchImpl(`${this.baseUrl}/image/upload`, {
      method: 'POST',
      headers: this.headers(),
      body: form,
    });
    const resp = await this.unwrap<{ img_id: number; img_url: string }>(res, 'uploadImage');
    return { imgId: resp.img_id, imgUrl: resp.img_url };
  }

  /** Text-to-video generation. Returns the PixVerse video_id. */
  async generateTextToVideo(params: GenerationParams): Promise<number> {
    assertValidGenerationParams(params);
    const body: Record<string, unknown> = {
      prompt: params.prompt,
      model: params.model,
      quality: params.quality,
      duration: params.duration,
      motion_mode: params.motionMode,
      aspect_ratio: params.aspectRatio ?? '16:9',
    };
    const negative = cleanNegative(params.negativePrompt);
    if (negative) body.negative_prompt = negative;
    const style = cleanStyle(params.style);
    if (style) body.style = style;
    if (params.seed !== undefined) body.seed = params.seed;

    const res = await this.fetchImpl(`${this.baseUrl}/video/text/generate`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    const resp = await this.unwrap<{ video_id: number }>(res, 'generateTextToVideo');
    return resp.video_id;
  }

  /** Image-to-video generation. Returns the PixVerse video_id. */
  async generateImageToVideo(params: GenerationParams): Promise<number> {
    assertValidGenerationParams(params, { requireImage: true });
    const body: Record<string, unknown> = {
      img_id: params.imageId,
      prompt: params.prompt ?? '',
      model: params.model,
      quality: params.quality,
      duration: params.duration,
      motion_mode: params.motionMode,
    };
    const negative = cleanNegative(params.negativePrompt);
    if (negative) body.negative_prompt = negative;
    const camera = cleanCamera(params.cameraMovement);
    if (camera) body.camera_movement = camera;
    if (params.seed !== undefined) body.seed = params.seed;

    const res = await this.fetchImpl(`${this.baseUrl}/video/img/generate`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    const resp = await this.unwrap<{ video_id: number }>(res, 'generateImageToVideo');
    return resp.video_id;
  }

  /**
   * Extend an existing rendered video with a new prompt/motion.
   * Returns the new video_id for the extended clip.
   */
  async extendVideo(
    videoId: number,
    params: Pick<GenerationParams, 'prompt' | 'model' | 'quality' | 'duration' | 'motionMode' | 'negativePrompt'>,
  ): Promise<number> {
    const body: Record<string, unknown> = {
      video_id: videoId,
      prompt: params.prompt,
      model: params.model,
      quality: params.quality,
      duration: params.duration,
      motion_mode: params.motionMode,
    };
    const negative = cleanNegative(params.negativePrompt);
    if (negative) body.negative_prompt = negative;

    const res = await this.fetchImpl(`${this.baseUrl}/video/extend/generate`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    const resp = await this.unwrap<{ video_id: number }>(res, 'extendVideo');
    return resp.video_id;
  }

  /** Fetch the current status/result for a video_id. */
  async getVideoResult(videoId: number): Promise<PixverseVideoResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/video/result/${videoId}`, {
      method: 'GET',
      headers: this.headers(),
    });
    const resp = await this.unwrap<Record<string, unknown>>(res, 'getVideoResult');
    const status = Number(resp.status);
    return {
      status,
      statusLabel: describePixverseStatus(status),
      url: (resp.url as string) || null,
      outputWidth: resp.outputWidth as number | undefined,
      outputHeight: resp.outputHeight as number | undefined,
      resolutionRatio: resp.resolution_ratio as string | undefined,
      seed: resp.seed as number | undefined,
      prompt: resp.prompt as string | undefined,
      raw: resp,
    };
  }

  /**
   * Poll a video until it succeeds or fails. Throws PixverseError on a
   * failed/moderation-failed/deleted status or when the timeout is exceeded.
   */
  async pollVideo(
    videoId: number,
    opts: { intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  ): Promise<PixverseVideoResult> {
    const intervalMs = opts.intervalMs ?? 5000;
    const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const result = await this.getVideoResult(videoId);
      if (result.status === PIXVERSE_STATUS.SUCCESS) return result;
      if (result.status === PIXVERSE_STATUS.MODERATION_FAILED) {
        throw new PixverseError(`Video ${videoId} failed content moderation`, undefined);
      }
      if (result.status === PIXVERSE_STATUS.FAILED) {
        throw new PixverseError(`Video ${videoId} generation failed`, undefined);
      }
      if (result.status === PIXVERSE_STATUS.DELETED) {
        throw new PixverseError(`Video ${videoId} was deleted`, undefined);
      }
      if (Date.now() + intervalMs > deadline) {
        throw new PixverseError(`Timed out waiting for video ${videoId} (last status: ${result.statusLabel})`);
      }
      await sleep(intervalMs);
    }
  }
}
