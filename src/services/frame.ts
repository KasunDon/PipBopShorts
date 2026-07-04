import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FFMPEG_BIN, hasFfmpeg } from './ffmpeg';

type FetchLike = typeof fetch;

export type FrameResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: string };

/**
 * Extract the first frame of a video as a PNG. Never throws — returns a
 * discriminated result so callers can surface *why* a still wasn't captured
 * (rather than silently having no reference image) while still treating it
 * as best-effort: a failure here never fails the overall portrait render.
 */
export async function extractFirstFrame(videoUrl: string, fetchImpl: FetchLike = fetch): Promise<FrameResult> {
  if (!hasFfmpeg()) {
    return { ok: false, reason: 'ffmpeg is not available on this server, so no still could be extracted.' };
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pipbop-frame-'));
  try {
    const res = await fetchImpl(videoUrl);
    if (!res.ok) return { ok: false, reason: `Could not download the rendered clip (HTTP ${res.status}).` };
    const input = path.join(dir, 'in.mp4');
    writeFileSync(input, new Uint8Array(await res.arrayBuffer()));
    const output = path.join(dir, 'frame.png');
    const r = spawnSync(FFMPEG_BIN, ['-y', '-i', input, '-frames:v', '1', '-q:v', '2', output], { stdio: 'ignore' });
    if (r.status !== 0) return { ok: false, reason: 'ffmpeg failed to extract a frame from the clip.' };
    return { ok: true, bytes: readFileSync(output) };
  } catch (err) {
    return { ok: false, reason: `Frame extraction failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
