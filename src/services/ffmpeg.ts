import { spawnSync } from 'node:child_process';
import ffmpegStaticPath from 'ffmpeg-static';

/**
 * Resolved ffmpeg binary. Prefers the bundled static build (no system install
 * or PATH dependency required) and falls back to a `ffmpeg` on PATH if the
 * bundled binary failed to download for this platform.
 */
export const FFMPEG_BIN: string = ffmpegStaticPath ?? 'ffmpeg';

/** Whether a working ffmpeg binary is available. */
export function hasFfmpeg(): boolean {
  try {
    const res = spawnSync(FFMPEG_BIN, ['-version'], { stdio: 'ignore' });
    return res.status === 0;
  } catch {
    return false;
  }
}
