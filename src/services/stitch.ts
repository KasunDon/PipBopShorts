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
    const listPath = path.join(dir, 'list.txt');
    writeFileSync(listPath, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
    const concatPath = path.join(dir, 'concat.mp4');
    const concat = spawnSync(
      FFMPEG_BIN,
      ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', concatPath],
      { stdio: 'ignore' },
    );
    if (concat.status !== 0) return null;

    const srt = options.burnSrt?.trim();
    if (!srt) return readFileSync(concatPath);

    // Second pass: burn the captions in (re-encodes the video; audio copied).
    const srtPath = path.join(dir, 'subs.srt');
    writeFileSync(srtPath, srt, 'utf8');
    const outPath = path.join(dir, 'out.mp4');
    const burn = spawnSync(
      FFMPEG_BIN,
      ['-y', '-i', concatPath, '-vf', `subtitles=${srtPath}`, '-c:a', 'copy', outPath],
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
