import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FFMPEG_BIN, hasFfmpeg } from './ffmpeg';

type FetchLike = typeof fetch;

export { hasFfmpeg };

export interface StitchOptions {
  /** SRT subtitle text to burn into the stitched video (sound-off captions). */
  burnSrt?: string;
  /** Crossfade between clips instead of a hard cut. */
  transition?: 'none' | 'fade';
  /** Crossfade duration in seconds (default 0.5). */
  transitionSec?: number;
}

/** Parse a clip's duration (seconds) from ffmpeg's stderr banner. */
function probeDuration(file: string): number | null {
  const res = spawnSync(FFMPEG_BIN, ['-i', file], { encoding: 'utf8' });
  const m = (res.stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** Build an xfade filtergraph chaining every clip with a crossfade; null if not applicable. */
function buildXfade(durations: number[], t: number): { filter: string; outLabel: string } | null {
  if (durations.length < 2) return null;
  if (durations.some((d) => !Number.isFinite(d) || d <= t)) return null; // too short to crossfade
  let prev = '[0:v]';
  let cumulative = durations[0];
  const parts: string[] = [];
  for (let i = 1; i < durations.length; i++) {
    const offset = Math.max(0, cumulative - t).toFixed(3);
    const out = i === durations.length - 1 ? '[vout]' : `[v${i}]`;
    parts.push(`${prev}[${i}:v]xfade=transition=fade:duration=${t}:offset=${offset}${out}`);
    prev = out;
    cumulative = cumulative + durations[i] - t;
  }
  return { filter: parts.join(';'), outLabel: '[vout]' };
}

/**
 * Concatenate several clip URLs into a single MP4 using ffmpeg, optionally
 * burning in a subtitle (.srt) track. Best-effort: returns null (rather than
 * throwing) when ffmpeg is unavailable or fails, so callers can gracefully fall
 * back to publishing a single clip.
 */
export async function stitchClips(
  urls: string[],
  fetchImpl: FetchLike = fetch,
  options: StitchOptions = {},
): Promise<Uint8Array | null> {
  if (urls.length === 0) return null;
  if (!hasFfmpeg()) return null;

  const dir = mkdtempSync(path.join(os.tmpdir(), 'pipbop-stitch-'));
  try {
    const files: string[] = [];
    for (let i = 0; i < urls.length; i++) {
      const res = await fetchImpl(urls[i]);
      if (!res.ok) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      const file = path.join(dir, `clip_${i}.mp4`);
      writeFileSync(file, bytes);
      files.push(file);
    }
    const basePath = path.join(dir, 'base.mp4');

    // Crossfade path (xfade) when requested and every clip is long enough; else a hard-cut concat.
    let built = false;
    if (options.transition === 'fade' && files.length >= 2) {
      const t = options.transitionSec ?? 0.5;
      const durations = files.map((f) => probeDuration(f) ?? NaN);
      const graph = buildXfade(durations, t);
      if (graph) {
        const inputs = files.flatMap((f) => ['-i', f]);
        const xf = spawnSync(
          FFMPEG_BIN,
          ['-y', ...inputs, '-filter_complex', graph.filter, '-map', graph.outLabel, '-an', basePath],
          { stdio: 'ignore' },
        );
        built = xf.status === 0;
      }
    }
    if (!built) {
      const listPath = path.join(dir, 'list.txt');
      writeFileSync(listPath, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
      const concat = spawnSync(
        FFMPEG_BIN,
        ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', basePath],
        { stdio: 'ignore' },
      );
      if (concat.status !== 0) return null;
    }
    const concatPath = basePath;

    const srt = options.burnSrt?.trim();
    if (!srt) return readFileSync(concatPath);

    // Second pass: burn the captions in (re-encodes the video; audio copied).
    const srtPath = path.join(dir, 'subs.srt');
    writeFileSync(srtPath, srt, 'utf8');
    const outPath = path.join(dir, 'out.mp4');
    // Bold, outlined, bottom-centred within the safe area — readable with sound off.
    const style = 'FontSize=18\\,Outline=2\\,Shadow=0\\,Alignment=2\\,MarginV=40';
    const burn = spawnSync(
      FFMPEG_BIN,
      ['-y', '-i', concatPath, '-vf', `subtitles=${srtPath}:force_style=${style}`, '-c:a', 'copy', outPath],
      { stdio: 'ignore' },
    );
    // If burning fails, fall back to the un-captioned concat rather than failing.
    return burn.status === 0 ? readFileSync(outPath) : readFileSync(concatPath);
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
