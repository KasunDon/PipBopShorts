import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasFfmpeg } from './stitch';

type FetchLike = typeof fetch;

/**
 * Extract the first frame of a video as a PNG, best-effort. Returns null (never
 * throws) when ffmpeg is unavailable or the extraction fails — callers fall
 * back to a manual still upload or descriptor-only references.
 */
export async function extractFirstFrame(videoUrl: string, fetchImpl: FetchLike = fetch): Promise<Uint8Array | null> {
  if (!hasFfmpeg()) return null;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pipbop-frame-'));
  try {
    const res = await fetchImpl(videoUrl);
    if (!res.ok) return null;
    const input = path.join(dir, 'in.mp4');
    writeFileSync(input, new Uint8Array(await res.arrayBuffer()));
    const output = path.join(dir, 'frame.png');
    const r = spawnSync('ffmpeg', ['-y', '-i', input, '-frames:v', '1', '-q:v', '2', output], { stdio: 'ignore' });
    if (r.status !== 0) return null;
    return readFileSync(output);
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
