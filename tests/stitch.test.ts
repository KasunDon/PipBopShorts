import { afterEach, describe, expect, it } from 'vitest';
import { hasFfmpeg, stitchClips } from '../src/services/stitch';
import { synthesizeTestVideo } from './helpers';

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

/** A fetch that serves in-memory synthesized clips by url. */
function clipFetch(bytes: Uint8Array): typeof fetch {
  return (async () => new Response(bytes, { status: 200, headers: { 'content-type': 'video/mp4' } })) as typeof fetch;
}

describe('stitchClips with burned captions', () => {
  it('concatenates clips and burns an SRT (subtitles filter available)', async () => {
    if (!hasFfmpeg()) return; // environment guard
    const clip = synthesizeTestVideo();
    const fetchImpl = clipFetch(clip);
    const srt = '1\n00:00:00,000 --> 00:00:01,000\nHello\n';

    const out = await stitchClips(['a.mp4', 'b.mp4'], fetchImpl, { burnSrt: srt });
    expect(out).not.toBeNull();
    expect((out as Uint8Array).length).toBeGreaterThan(0);
  });

  it('still stitches when no captions are provided', async () => {
    if (!hasFfmpeg()) return;
    const out = await stitchClips(['a.mp4', 'b.mp4'], clipFetch(synthesizeTestVideo()));
    expect(out).not.toBeNull();
  });
});
