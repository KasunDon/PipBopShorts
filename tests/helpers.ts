import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AnthropicLike, AnthropicResponse } from '../src/clients/claude';
import { PixverseClient } from '../src/clients/pixverse';
import { YoutubeClient } from '../src/clients/youtube';
import { Store } from '../src/store/store';

export function makeStore(): { store: Store; dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipbop-test-'));
  const store = new Store(dir);
  return { store, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export const noSleep = async (): Promise<void> => {};

/** A valid storyline object (as Claude would return via structured output). */
export function sampleStorylineJson(sceneCount = 2): string {
  const scenes = Array.from({ length: sceneCount }, (_, i) => ({
    heading: `Scene ${i + 1}`,
    description: `Description ${i + 1}`,
    prompt: `A vivid shot number ${i + 1} of the hero in a neon city, cinematic lighting`,
    negative_prompt: 'blurry, watermark, text',
    duration: 5,
    aspect_ratio: '9:16',
    model: 'v5',
    quality: '540p',
    motion_mode: 'normal',
    style: 'none',
    camera_movement: i % 2 === 0 ? 'zoom_in' : 'none',
  }));
  return JSON.stringify({
    title: 'Neon Nights',
    logline: 'A hero races through a neon city.',
    scenes,
    youtube: {
      title: 'Neon Nights — Episode 1',
      description: 'The chase begins.',
      tags: ['neon', 'cyberpunk', 'ai'],
      hashtags: ['#Shorts', '#AI', '#cyberpunk'],
    },
  });
}

export interface FakeClaudeCall {
  path: 'messages' | 'beta.messages';
  params: Record<string, unknown>;
}

/** Fake Anthropic client capturing calls; returns provided response (default: sample storyline). */
export function makeFakeClaude(
  responder?: (params: Record<string, unknown>) => AnthropicResponse,
): { client: AnthropicLike; calls: FakeClaudeCall[] } {
  const calls: FakeClaudeCall[] = [];
  const defaultResponse = (): AnthropicResponse => ({
    stop_reason: 'end_turn',
    model: 'fake',
    content: [{ type: 'text', text: sampleStorylineJson() }],
  });
  const client: AnthropicLike = {
    messages: {
      async create(params) {
        calls.push({ path: 'messages', params });
        return responder ? responder(params) : defaultResponse();
      },
    },
    beta: {
      messages: {
        async create(params) {
          calls.push({ path: 'beta.messages', params });
          return responder ? responder(params) : defaultResponse();
        },
      },
    },
  };
  return { client, calls };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export interface FakePixverseOptions {
  /** video_id -> sequence of statuses returned by successive /video/result calls. */
  resultSequences?: Record<number, number[]>;
  /** Default status for videos without an explicit sequence. */
  defaultStatus?: number;
  /** URL returned when a video reaches success (status 1). */
  successUrl?: string;
  textVideoId?: number;
  imgVideoId?: number;
  extendVideoId?: number;
}

export interface FakePixverse {
  client: PixverseClient;
  requests: Array<{ url: string; method: string; body: unknown }>;
}

/** Build a PixverseClient backed by an in-memory fake of the HTTP API. */
export function makeFakePixverse(options: FakePixverseOptions = {}): FakePixverse {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const pollCounts = new Map<number, number>();
  const successUrl = options.successUrl ?? 'https://cdn.pixverse.test/video.mp4';

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown = undefined;
    if (init?.body && typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    requests.push({ url, method, body });

    if (url.endsWith('/image/upload')) {
      return jsonResponse({ ErrCode: 0, ErrMsg: 'ok', Resp: { img_id: 42, img_url: 'https://img.test/x.png' } });
    }
    if (url.endsWith('/video/text/generate')) {
      return jsonResponse({ ErrCode: 0, ErrMsg: 'ok', Resp: { video_id: options.textVideoId ?? 111 } });
    }
    if (url.endsWith('/video/img/generate')) {
      return jsonResponse({ ErrCode: 0, ErrMsg: 'ok', Resp: { video_id: options.imgVideoId ?? 222 } });
    }
    if (url.endsWith('/video/extend/generate')) {
      return jsonResponse({ ErrCode: 0, ErrMsg: 'ok', Resp: { video_id: options.extendVideoId ?? 333 } });
    }
    const resultMatch = url.match(/\/video\/result\/(\d+)$/);
    if (resultMatch) {
      const videoId = Number(resultMatch[1]);
      const seq = options.resultSequences?.[videoId];
      let status: number;
      if (seq && seq.length > 0) {
        const n = pollCounts.get(videoId) ?? 0;
        status = seq[Math.min(n, seq.length - 1)];
        pollCounts.set(videoId, n + 1);
      } else {
        status = options.defaultStatus ?? 1;
      }
      const resp: Record<string, unknown> = { status, url: status === 1 ? successUrl : '' };
      return jsonResponse({ ErrCode: 0, ErrMsg: 'ok', Resp: resp });
    }
    return jsonResponse({ ErrCode: 500, ErrMsg: `unhandled ${method} ${url}`, Resp: {} }, 404);
  };

  const client = new PixverseClient({
    apiKey: 'test-key',
    baseUrl: 'https://app-api.pixverse.ai/openapi/v2',
    fetchImpl,
    traceId: () => 'trace-fixed',
  });
  return { client, requests };
}

/** A YouTube client in dry-run mode (no network). */
export function makeDryRunYoutube(): YoutubeClient {
  return new YoutubeClient({ dryRun: true });
}
