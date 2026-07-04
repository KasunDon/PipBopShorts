import type { Store } from '../store/store';

function srtTime(totalSeconds: number): string {
  const ms = Math.round((totalSeconds - Math.floor(totalSeconds)) * 1000);
  const s = Math.floor(totalSeconds) % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

export interface CaptionEntry {
  caption: string;
  durationSec: number;
}

/** Build SRT text from (caption, duration) pairs; captioned blocks are timed back-to-back. */
export function buildSrt(entries: CaptionEntry[]): string {
  const blocks: string[] = [];
  let cursor = 0;
  let index = 0;
  for (const entry of entries) {
    const dur = Number(entry.durationSec) || 0;
    const caption = (entry.caption ?? '').trim();
    if (caption) {
      index += 1;
      blocks.push(`${index}\n${srtTime(cursor)} --> ${srtTime(cursor + dur)}\n${caption}`);
    }
    cursor += dur;
  }
  return blocks.join('\n\n') + (blocks.length ? '\n' : '');
}

/** Scenes in order with their caption + duration. */
export function captionEntries(store: Store, storylineId: string): CaptionEntry[] {
  const project = store.getProject(storylineId);
  return [...project.storyline.scenes]
    .sort((a, b) => a.order - b.order)
    .map((s) => ({ caption: s.caption ?? '', durationSec: Number(s.duration) || 0 }));
}

/**
 * Build an SRT subtitle track from each scene's caption, timed to the scene
 * durations (the stitched short plays scenes back-to-back). Deterministic.
 */
export function buildCaptionsSrt(store: Store, storylineId: string): string {
  return buildSrt(captionEntries(store, storylineId));
}
