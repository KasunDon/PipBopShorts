import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FFMPEG_BIN } from '../src/services/ffmpeg';
import { hasFfmpeg, stitchClips } from '../src/services/stitch';
import { renderTitleCard } from '../src/services/titlecard';
import { synthesizeTestVideo } from './helpers';

/** A ~2s solid-colour clip, long enough to crossfade. */
function synthesizeClip(seconds: number, color: string): Uint8Array {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipbop-stitchfix-'));
  try {
    const p = path.join(dir, 'c.mp4');
    spawnSync(FFMPEG_BIN, ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=64x64:d=${seconds}`, '-r', '10', '-pix_fmt', 'yuv420p', p], { stdio: 'ignore' });
    return new Uint8Array(fs.readFileSync(p));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

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

  it('crossfades between clips when transition=fade', async () => {
    if (!hasFfmpeg()) return;
    const clip = synthesizeClip(2, 'red');
    const out = await stitchClips(['a.mp4', 'b.mp4'], clipFetch(clip), { transition: 'fade', transitionSec: 0.5 });
    expect(out).not.toBeNull();
    expect((out as Uint8Array).length).toBeGreaterThan(0);
  });

  it('falls back to a hard cut when clips are too short to crossfade', async () => {
    if (!hasFfmpeg()) return;
    // The tiny synthesized fixture is far shorter than the 0.5s transition.
    const out = await stitchClips(['a.mp4', 'b.mp4'], clipFetch(synthesizeTestVideo()), { transition: 'fade' });
    expect(out).not.toBeNull(); // still stitched, just without the crossfade
  });

  it('renders a title card with libass (no drawtext needed)', () => {
    if (!hasFfmpeg()) return;
    const card = renderTitleCard('My Great Short', { width: 128, height: 228, seconds: 1, subtitle: 'Episode 1' });
    expect(card).not.toBeNull();
    expect((card as Uint8Array).length).toBeGreaterThan(0);
  });

  it('assembles clips with title and end cards', async () => {
    if (!hasFfmpeg()) return;
    const out = await stitchClips(['a.mp4', 'b.mp4'], clipFetch(synthesizeClip(1, 'green')), {
      titleCard: 'Opening',
      endCard: 'The End',
      cardSeconds: 1,
      burnSrt: '1\n00:00:00,000 --> 00:00:01,000\nHi\n',
    });
    expect(out).not.toBeNull();
    expect((out as Uint8Array).length).toBeGreaterThan(0);
  });
});
