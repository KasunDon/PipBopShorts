import { describe, expect, it } from 'vitest';
import { extractFirstFrame } from '../src/services/frame';
import { FFMPEG_BIN, hasFfmpeg } from '../src/services/ffmpeg';
import { synthesizeTestVideo } from './helpers';

describe('ffmpeg module', () => {
  it('resolves a working ffmpeg binary (bundled via ffmpeg-static, no system install needed)', () => {
    expect(hasFfmpeg()).toBe(true);
    expect(FFMPEG_BIN).toBeTruthy();
  });
});

describe('extractFirstFrame', () => {
  it('extracts a real PNG frame from a rendered video (proves stills are actually captured)', async () => {
    const videoBytes = synthesizeTestVideo();
    const fetchImpl = (async () => new Response(videoBytes)) as unknown as typeof fetch;

    const result = await extractFirstFrame('http://fake/video.mp4', fetchImpl);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bytes.length).toBeGreaterThan(0);
      // PNG magic bytes.
      expect(result.bytes[0]).toBe(0x89);
      expect(result.bytes[1]).toBe(0x50);
    }
  });

  it('reports a clear reason when the video download fails', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    const result = await extractFirstFrame('http://fake/video.mp4', fetchImpl);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('HTTP 404');
  });

  it('reports a clear reason when the downloaded bytes are not a valid video', async () => {
    const fetchImpl = (async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;
    const result = await extractFirstFrame('http://fake/video.mp4', fetchImpl);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('ffmpeg failed');
  });
});
