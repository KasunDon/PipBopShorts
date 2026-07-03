import { describe, expect, it } from 'vitest';
import {
  PixverseClient,
  PixverseError,
  ValidationError,
  assertValidGenerationParams,
  collectValidationIssues,
  type GenerationParams,
} from '../src/clients/pixverse';
import { makeFakePixverse, noSleep } from './helpers';

const baseParams: GenerationParams = {
  prompt: 'a cat astronaut floating in space',
  model: 'v5',
  quality: '540p',
  duration: 5,
  motionMode: 'normal',
  aspectRatio: '9:16',
};

describe('validation', () => {
  it('accepts valid params', () => {
    expect(collectValidationIssues(baseParams)).toEqual([]);
  });

  it('rejects empty prompt with no image', () => {
    const issues = collectValidationIssues({ ...baseParams, prompt: '' });
    expect(issues.some((i) => i.includes('prompt'))).toBe(true);
  });

  it('rejects invalid enum values', () => {
    const issues = collectValidationIssues({
      ...baseParams,
      model: 'v9' as GenerationParams['model'],
      quality: '4k' as GenerationParams['quality'],
    });
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });

  it('enforces 1080p 5-second cap', () => {
    const issues = collectValidationIssues({ ...baseParams, quality: '1080p', duration: 8 });
    expect(issues.some((i) => i.includes('1080p'))).toBe(true);
  });

  it('enforces fast motion only at 5s', () => {
    const issues = collectValidationIssues({ ...baseParams, motionMode: 'fast', duration: 8 });
    expect(issues.some((i) => i.includes('fast motion'))).toBe(true);
  });

  it('requires an image for image-to-video', () => {
    const issues = collectValidationIssues(baseParams, { requireImage: true });
    expect(issues.some((i) => i.includes('image'))).toBe(true);
  });

  it('assertValidGenerationParams throws ValidationError', () => {
    expect(() => assertValidGenerationParams({ ...baseParams, prompt: '' })).toThrow(ValidationError);
  });
});

describe('PixverseClient request shaping', () => {
  it('sends API-KEY and Ai-trace-id headers and correct body for text-to-video', async () => {
    const requests: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return new Response(JSON.stringify({ ErrCode: 0, ErrMsg: 'ok', Resp: { video_id: 777 } }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = new PixverseClient({ apiKey: 'secret', fetchImpl, traceId: () => 'trace-1' });

    const id = await client.generateTextToVideo({ ...baseParams, style: 'anime', negativePrompt: 'blur' });
    expect(id).toBe(777);

    const req = requests[0];
    expect(req.url).toContain('/video/text/generate');
    expect(req.headers.get('API-KEY')).toBe('secret');
    expect(req.headers.get('Ai-trace-id')).toBe('trace-1');
    expect(req.body).toMatchObject({
      prompt: baseParams.prompt,
      model: 'v5',
      quality: '540p',
      duration: 5,
      motion_mode: 'normal',
      aspect_ratio: '9:16',
      style: 'anime',
      negative_prompt: 'blur',
    });
  });

  it('omits style "none" and empty negative prompt', async () => {
    const bodies: unknown[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      bodies.push(init?.body ? JSON.parse(init.body as string) : undefined);
      return new Response(JSON.stringify({ ErrCode: 0, ErrMsg: 'ok', Resp: { video_id: 1 } }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = new PixverseClient({ apiKey: 'k', fetchImpl });
    await client.generateTextToVideo({ ...baseParams, style: 'none', negativePrompt: '   ' });
    expect(bodies[0]).not.toHaveProperty('style');
    expect(bodies[0]).not.toHaveProperty('negative_prompt');
  });

  it('sends img_id and camera_movement for image-to-video', async () => {
    const bodies: unknown[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      bodies.push(init?.body ? JSON.parse(init.body as string) : undefined);
      return new Response(JSON.stringify({ ErrCode: 0, ErrMsg: 'ok', Resp: { video_id: 5 } }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = new PixverseClient({ apiKey: 'k', fetchImpl });
    await client.generateImageToVideo({ ...baseParams, imageId: 88, cameraMovement: 'zoom_in' });
    expect(bodies[0]).toMatchObject({ img_id: 88, camera_movement: 'zoom_in' });
  });
});

describe('PixverseClient error handling', () => {
  it('throws PixverseError on non-zero ErrCode', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ ErrCode: 400123, ErrMsg: 'insufficient credits', Resp: {} }), {
        headers: { 'content-type': 'application/json' },
      });
    const client = new PixverseClient({ apiKey: 'k', fetchImpl });
    await expect(client.generateTextToVideo(baseParams)).rejects.toMatchObject({
      name: 'PixverseError',
      errCode: 400123,
    });
  });

  it('throws PixverseError on HTTP error', async () => {
    const fetchImpl: typeof fetch = async () => new Response('nope', { status: 500 });
    const client = new PixverseClient({ apiKey: 'k', fetchImpl });
    await expect(client.getVideoResult(1)).rejects.toBeInstanceOf(PixverseError);
  });
});

describe('polling', () => {
  it('polls until success', async () => {
    const { client } = makeFakePixverse({ resultSequences: { 111: [5, 5, 1] } });
    const result = await client.pollVideo(111, { intervalMs: 1, timeoutMs: 10000, sleep: noSleep });
    expect(result.status).toBe(1);
    expect(result.statusLabel).toBe('succeeded');
    expect(result.url).toContain('.mp4');
  });

  it('throws on moderation failure', async () => {
    const { client } = makeFakePixverse({ resultSequences: { 111: [5, 7] } });
    await expect(client.pollVideo(111, { intervalMs: 1, sleep: noSleep })).rejects.toThrow(/moderation/i);
  });

  it('throws on generation failure', async () => {
    const { client } = makeFakePixverse({ resultSequences: { 111: [8] } });
    await expect(client.pollVideo(111, { intervalMs: 1, sleep: noSleep })).rejects.toThrow(/failed/i);
  });

  it('times out when never ready', async () => {
    const { client } = makeFakePixverse({ resultSequences: { 111: [5] } });
    await expect(client.pollVideo(111, { intervalMs: 1000, timeoutMs: 10, sleep: noSleep })).rejects.toThrow(/Timed out/);
  });
});

describe('uploadImage', () => {
  it('returns img id and url', async () => {
    const { client } = makeFakePixverse();
    const result = await client.uploadImage(new Uint8Array([1, 2, 3]), 'a.png', 'image/png');
    expect(result).toEqual({ imgId: 42, imgUrl: 'https://img.test/x.png' });
  });
});
