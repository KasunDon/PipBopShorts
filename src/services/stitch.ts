import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FFMPEG_BIN, hasFfmpeg } from './ffmpeg';
import { renderTitleCard } from './titlecard';

type FetchLike = typeof fetch;

export { hasFfmpeg };

/** Probe a clip's pixel dimensions from ffmpeg's stderr banner. */
function probeResolution(file: string): { width: number; height: number } | null {
  const res = spawnSync(FFMPEG_BIN, ['-i', file], { encoding: 'utf8' });
  const m = (res.stderr || '').match(/Video:.*?(\d{2,5})x(\d{2,5})/);
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** Shift every timestamp in an SRT by offsetSec (used when a title card is prepended). */
function shiftSrt(srt: string, offsetSec: number): string {
  if (offsetSec <= 0) return srt;
  const bump = (t: string): string => {
    const m = t.match(/(\d+):(\d+):(\d+),(\d+)/);
    if (!m) return t;
    let total = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000 + offsetSec;
    const h = Math.floor(total / 3600);
    total -= h * 3600;
    const mm = Math.floor(total / 60);
    total -= mm * 60;
    const s = Math.floor(total);
    const ms = Math.round((total - s) * 1000);
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${p(h)}:${p(mm)}:${p(s)},${p(ms, 3)}`;
  };
  return srt.replace(/(\d+:\d+:\d+,\d+) --> (\d+:\d+:\d+,\d+)/g, (_all, a, b) => `${bump(a)} --> ${bump(b)}`);
}

export interface StitchOptions {
  /** SRT subtitle text to burn into the stitched video (sound-off captions). */
  burnSrt?: string;
  /** Crossfade between clips instead of a hard cut. */
  transition?: 'none' | 'fade';
  /** Crossfade duration in seconds (default 0.5). */
  transitionSec?: number;
  /** Opening title card text (rendered over a solid background via libass). */
  titleCard?: string;
  /** Optional smaller line under the title. */
  titleSubtitle?: string;
  /** Closing end card text. */
  endCard?: string;
  /** Title/end card duration in seconds (default 2). */
  cardSeconds?: number;
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
    let built = false;
    let captionOffset = 0;

    // Title/end cards: normalise every input and concatenate them via the filter
    // graph (robust to differing clip resolutions). Cards are rendered with libass.
    const wantCards = Boolean(options.titleCard?.trim() || options.endCard?.trim());
    if (wantCards) {
      const dim = probeResolution(files[0]) ?? { width: 720, height: 1280 };
      const cardSeconds = options.cardSeconds ?? 2;
      const inputs: string[] = [];
      if (options.titleCard?.trim()) {
        const bytes = renderTitleCard(options.titleCard, {
          width: dim.width,
          height: dim.height,
          seconds: cardSeconds,
          subtitle: options.titleSubtitle,
          background: '0x101014',
        });
        if (bytes) {
          const p = path.join(dir, 'title.mp4');
          writeFileSync(p, bytes);
          inputs.push(p);
          captionOffset = cardSeconds; // captions are timed after the title card
        }
      }
      inputs.push(...files);
      if (options.endCard?.trim()) {
        const bytes = renderTitleCard(options.endCard, { width: dim.width, height: dim.height, seconds: cardSeconds, background: '0x101014' });
        if (bytes) {
          const p = path.join(dir, 'end.mp4');
          writeFileSync(p, bytes);
          inputs.push(p);
        }
      }
      const args = inputs.flatMap((f) => ['-i', f]);
      const norm = inputs
        .map(
          (_f, i) =>
            `[${i}:v]scale=${dim.width}:${dim.height}:force_original_aspect_ratio=decrease,pad=${dim.width}:${dim.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=24,format=yuv420p[v${i}]`,
        )
        .join(';');
      const labels = inputs.map((_f, i) => `[v${i}]`).join('');
      const filter = `${norm};${labels}concat=n=${inputs.length}:v=1:a=0[vout]`;
      const assemble = spawnSync(
        FFMPEG_BIN,
        ['-y', ...args, '-filter_complex', filter, '-map', '[vout]', '-an', basePath],
        { stdio: 'ignore' },
      );
      built = assemble.status === 0;
    }

    // Crossfade path (xfade) when requested and every clip is long enough; else a hard-cut concat.
    if (!built && options.transition === 'fade' && files.length >= 2) {
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

    const rawSrt = options.burnSrt?.trim();
    if (!rawSrt) return readFileSync(concatPath);
    // Shift captions to sit after any prepended title card.
    const srt = shiftSrt(rawSrt, captionOffset);

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
