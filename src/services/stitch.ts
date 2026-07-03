import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type FetchLike = typeof fetch;

/** Whether an ffmpeg binary is available on PATH. */
export function hasFfmpeg(): boolean {
  try {
    const res = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return res.status === 0;
  } catch {
    return false;
  }
}

/**
 * Concatenate several clip URLs into a single MP4 using ffmpeg. Best-effort:
 * returns null (rather than throwing) when ffmpeg is unavailable or fails, so
 * callers can gracefully fall back to publishing a single clip.
 */
export async function stitchClips(urls: string[], fetchImpl: FetchLike = fetch): Promise<Uint8Array | null> {
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
    const outPath = path.join(dir, 'out.mp4');
    const res = spawnSync(
      'ffmpeg',
      ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath],
      { stdio: 'ignore' },
    );
    if (res.status !== 0) return null;
    return readFileSync(outPath);
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
