import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AnthropicLike, AnthropicResponse } from '../src/clients/claude';
import { PixverseClient } from '../src/clients/pixverse';
import { YoutubeClient } from '../src/clients/youtube';
import { FFMPEG_BIN } from '../src/services/ffmpeg';
import { Store } from '../src/store/store';

/** Synthesize a tiny real test video with ffmpeg itself — a fully self-contained fixture for frame-extraction tests. */
export function synthesizeTestVideo(): Uint8Array {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipbop-frame-fixture-'));
  try {
    const videoPath = path.join(dir, 'test.mp4');
    const gen = spawnSync(
      FFMPEG_BIN,
      ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=1', '-frames:v', '5', videoPath],
      { stdio: 'ignore' },
    );
    if (gen.status !== 0) throw new Error('failed to synthesize fixture video');
    return new Uint8Array(fs.readFileSync(videoPath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

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

/** A canon extraction payload (as Claude would return via structured output). */
export function sampleCanonExtractionJson(): string {
  return JSON.stringify({
    entities: [
      {
        type: 'character',
        name: 'Bobo',
        summary: 'Energetic young monkey, the comic lead.',
        marks: [
          { key: 'scarf', value: 'bright green leaf scarf', severity: 'locked', rationale: 'Signature accessory.' },
          { key: 'fur_color', value: 'golden-brown fur, warm cream face', severity: 'locked', rationale: 'Brand recognition.' },
          { key: 'personality', value: 'playful, brave, rushes in', severity: 'strong', rationale: 'Drives comedy.' },
        ],
      },
      {
        type: 'location',
        name: 'Giggle Tree',
        summary: 'Large rounded fruit tree at the center of the grove.',
        marks: [
          { key: 'landmarks', value: 'curved branches, hanging bananas, friendly hollow', severity: 'strong', rationale: 'Recurring set.' },
        ],
      },
      {
        type: 'world_rule',
        name: 'Harmless physics',
        summary: 'Objects behave in funny but harmless ways.',
        marks: [
          { key: 'accidents', value: 'every fall lands softly with a funny sound', severity: 'locked', rationale: 'Child safety.' },
        ],
      },
      {
        type: 'visual_style',
        name: 'Render style',
        summary: 'Rounded stylized 3D.',
        marks: [
          { key: 'style', value: 'rounded stylized 3D, bright colors, soft cinematic lighting', severity: 'locked', rationale: 'Series look.' },
          {
            key: 'reference_background',
            value: 'seamless mint-green studio backdrop, even soft light',
            severity: 'locked',
            rationale: 'Consistent reference set.',
          },
        ],
      },
    ],
    negative_prompt: 'violence, dark shadows, photorealism, scary imagery',
  });
}

/** A drift report payload with one high and one low finding. */
export function sampleDriftJson(): string {
  return JSON.stringify({
    summary: 'One locked mark contradicted; one minor tone note.',
    findings: [
      {
        entity_name: 'Bobo',
        mark_key: 'scarf',
        expected: 'bright green leaf scarf',
        observed: 'red woolly scarf',
        scene_numbers: [1],
        severity: 'high',
        category: 'consistency',
        explanation: 'Scene 1 dresses Bobo in a red scarf, contradicting the locked signature accessory.',
        suggestion: 'Change the scene prompt to the bright green leaf scarf, or accept the change into canon.',
      },
      {
        entity_name: 'Giggle Tree',
        mark_key: 'landmarks',
        expected: 'hanging bananas present',
        observed: 'no bananas mentioned',
        scene_numbers: [2],
        severity: 'low',
        category: 'consistency',
        explanation: 'Scene 2 omits the hanging bananas.',
        suggestion: 'Optionally mention the bananas for set continuity.',
      },
    ],
  });
}

/** An auto-fix payload: shorten a fast-motion 8s scene to 5s, keeping its energy. */
export function sampleAutofixJson(): string {
  return JSON.stringify({
    fixes: [
      {
        scene_number: 1,
        duration: 5,
        quality: '540p',
        motion_mode: 'fast',
        model: 'v5',
        aspect_ratio: '9:16',
        style: 'none',
        camera_movement: 'zoom_in',
        rationale: 'Kept the fast-motion energy by shortening the beat to 5s.',
      },
    ],
  });
}

/** A scene-patch payload: change one thing, preserve the rest. */
export function samplePatchJson(): string {
  return JSON.stringify({
    new_prompt: 'A vivid shot number 1 of the hero in a neon city, cinematic lighting, the hero now looks worried',
    changed: "Added a worried expression to the hero's face.",
    preserved: ['neon city setting', 'cinematic lighting', 'hero design'],
    rationale: 'Only the facial expression was adjusted; nothing else in the shot moved.',
  });
}

/** A dialogue/caption plan payload for a 2-scene storyline. */
export function sampleDialogueJson(): string {
  return JSON.stringify({
    scenes: [
      { scene_number: 1, caption: 'A neon night begins!', lines: [{ speaker: 'Hero', text: "Let's go!" }] },
      { scene_number: 2, caption: 'The chase is on.', lines: [] },
    ],
  });
}

/** A beat-sheet payload. */
export function sampleBeatSheetJson(): string {
  return JSON.stringify({
    beats: [
      { name: 'Hook', description: 'Bobo spots the perfect banana high in the Giggle Tree.', purpose: 'Sets the goal.' },
      { name: 'Complication', description: 'The branch is too high and wobbly.', purpose: 'Raises the stakes.' },
      { name: 'Turn', description: 'A friend suggests teamwork.', purpose: 'Introduces the lesson.' },
      { name: 'Climax', description: 'They build a wobbly ladder of friends.', purpose: 'Peak tension, comedic.' },
      { name: 'Resolution', description: 'Everyone shares the banana.', purpose: 'Warm, safe payoff.' },
    ],
  });
}

/** An episode-ideas backlog payload. */
export function sampleEpisodeIdeasJson(count = 3): string {
  return JSON.stringify({
    ideas: Array.from({ length: count }, (_, i) => ({
      title: `Idea ${i + 1}`,
      hook: `A fresh hook number ${i + 1}.`,
      synopsis: `Bobo faces a new harmless mishap number ${i + 1} and learns a small lesson with his friends.`,
    })),
  });
}

/** A story-bootstrap payload (idea → title/meta/bible). */
export function sampleBootstrapJson(): string {
  return JSON.stringify({
    title: 'Rocket Raccoons',
    setting_mode: 'shared',
    meta: {
      audience_min: 5,
      audience_max: 8,
      audience_notes: 'must work with sound off',
      genres: ['comedy', 'sci-fi'],
      tones: ['cheerful', 'curious', 'safe'],
      format: '3D animated comedy shorts',
      episode_length_sec: 60,
      language: 'English',
    },
    bible_markdown:
      '# Rocket Raccoons — Story Bible\n\n## 1. Premise\nTwo raccoon siblings run a tiny junkyard space program.\n\n## 4. Main Characters\n### Rizzo\n- **Visual signature:** grey raccoon, oversized amber goggles.\n- **Never change:** goggles, grey fur.\n',
  });
}

/** An episode-draft payload (idea → title/brief/setting). */
export function sampleEpisodeDraftJson(): string {
  return JSON.stringify({
    title: 'The Wobbly Launch',
    brief: 'Rizzo builds a bottle rocket that only flies in circles. The siblings learn to aim together and land it in the pillow pile.',
    setting_markdown: '# Junkyard launchpad\nStacked tires, fairy lights, soft pillow landing zone.',
  });
}

/** A season-plan payload for a linear story. */
export function samplePlanJson(episodeCount = 3): string {
  return JSON.stringify({
    arc_summary: 'The friends build a rocket piece by piece until launch day.',
    finale: 'The rocket finally flies over the grove at sunset.',
    episodes: Array.from({ length: episodeCount }, (_, i) => ({
      title: `Chapter ${i + 1}`,
      synopsis: `Step ${i + 1} of building the rocket goes hilariously sideways before the friends fix it together.`,
      arc_note: `Adds rocket part ${i + 1}; carries momentum into the next episode.`,
    })),
  });
}

/**
 * A fake Claude that routes by task: canon extraction, drift check, story
 * bootstrap, season plan, episode draft/generation, or storyline generation —
 * so end-to-end studio flows can run against one fake.
 */
export function makeStudioFakeClaude(overrides?: {
  canonJson?: string;
  driftJson?: string;
  storylineJson?: string;
  bootstrapJson?: string;
  episodeDraftJson?: string;
  planJson?: string;
  autofixJson?: string;
  patchJson?: string;
  ideasJson?: string;
  beatSheetJson?: string;
  dialogueJson?: string;
  localizeJson?: string;
  titlesJson?: string;
}): { client: AnthropicLike; calls: FakeClaudeCall[] } {
  return makeFakeClaude((params) => {
    const system = String(params.system ?? '');
    let text: string;
    if (system.includes('Dissect a story bible')) {
      text = overrides?.canonJson ?? sampleCanonExtractionJson();
    } else if (system.includes('report every drift')) {
      text = overrides?.driftJson ?? sampleDriftJson();
    } else if (system.includes('technical delivery supervisor')) {
      text = overrides?.autofixJson ?? sampleAutofixJson();
    } else if (system.includes('applying a DIRECTED edit')) {
      text = overrides?.patchJson ?? samplePatchJson();
    } else if (system.includes('brainstorming FUTURE episode')) {
      text = overrides?.ideasJson ?? sampleEpisodeIdeasJson();
    } else if (system.includes('building a BEAT SHEET')) {
      text = overrides?.beatSheetJson ?? sampleBeatSheetJson();
    } else if (system.includes('dialogue and caption writer')) {
      text = overrides?.dialogueJson ?? sampleDialogueJson();
    } else if (system.includes('localize a YouTube')) {
      text =
        overrides?.localizeJson ??
        JSON.stringify({ title: 'Título localizado', description: 'Descripción', tags: ['etiqueta'], hashtags: ['#Shorts'] });
    } else if (system.includes('A/B title options')) {
      text =
        overrides?.titlesJson ??
        JSON.stringify({
          variants: [
            { title: 'The Banana Heist', angle: 'curiosity' },
            { title: 'Can Bobo Reach It?', angle: 'stakes' },
          ],
        });
    } else if (system.includes('head of story development')) {
      text = overrides?.bootstrapJson ?? sampleBootstrapJson();
    } else if (system.includes('season architect')) {
      text = overrides?.planJson ?? samplePlanJson();
    } else if (system.includes('episode developer')) {
      text = overrides?.episodeDraftJson ?? sampleEpisodeDraftJson();
    } else {
      text = overrides?.storylineJson ?? sampleStorylineJson();
    }
    return { stop_reason: 'end_turn', model: 'fake', content: [{ type: 'text', text }] };
  });
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
