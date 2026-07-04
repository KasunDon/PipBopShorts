import type { Store } from '../store/store';

function srtTime(totalSeconds: number): string {
  const ms = Math.round((totalSeconds - Math.floor(totalSeconds)) * 1000);
  const s = Math.floor(totalSeconds) % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/**
 * Build an SRT subtitle track from each scene's caption, timed to the scene
 * durations (the stitched short plays scenes back-to-back). Scenes without a
 * caption are skipped but still advance the clock. Deterministic — no network.
 */
export function buildCaptionsSrt(store: Store, storylineId: string): string {
  const project = store.getProject(storylineId);
  const scenes = [...project.storyline.scenes].sort((a, b) => a.order - b.order);

  const blocks: string[] = [];
  let cursor = 0;
  let index = 0;
  for (const scene of scenes) {
    const dur = Number(scene.duration) || 0;
    const caption = (scene.caption ?? '').trim();
    if (caption) {
      index += 1;
      blocks.push(`${index}\n${srtTime(cursor)} --> ${srtTime(cursor + dur)}\n${caption}`);
    }
    cursor += dur;
  }
  return blocks.join('\n\n') + (blocks.length ? '\n' : '');
}
