import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FFMPEG_BIN, hasFfmpeg } from './ffmpeg';

export interface TitleCardOptions {
  width?: number;
  height?: number;
  seconds?: number;
  /** Optional smaller subtitle line under the title. */
  subtitle?: string;
  /** Background colour (ffmpeg colour name or hex like 0x101014). */
  background?: string;
}

/** ASS text-field escaping: newlines → \N, strip braces that would start an override block. */
function assText(s: string): string {
  return s.replace(/[{}]/g, '').replace(/\r?\n/g, '\\N').trim();
}

/**
 * Render a title/end card MP4 (centred text over a solid background) using
 * ffmpeg's libass `subtitles` filter — no `drawtext`/font dependency needed.
 * Best-effort: returns null when ffmpeg is unavailable or the render fails.
 */
export function renderTitleCard(title: string, options: TitleCardOptions = {}): Uint8Array | null {
  if (!hasFfmpeg()) return null;
  const width = options.width ?? 720;
  const height = options.height ?? 1280;
  const seconds = options.seconds ?? 2;
  const bg = options.background ?? 'black';

  const dir = mkdtempSync(path.join(os.tmpdir(), 'pipbop-title-'));
  try {
    const titleFs = Math.round(height / 16);
    const subFs = Math.round(height / 30);
    const events: string[] = [
      `Dialogue: 0,0:00:00.00,${assSeconds(seconds)},Title,,${assText(title)}`,
    ];
    if (options.subtitle && options.subtitle.trim()) {
      events.push(`Dialogue: 0,0:00:00.00,${assSeconds(seconds)},Sub,,${assText(options.subtitle)}`);
    }
    const ass = [
      '[Script Info]',
      'ScriptType: v4.00+',
      `PlayResX: ${width}`,
      `PlayResY: ${height}`,
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, Bold, Alignment, MarginV',
      `Style: Title,Arial,${titleFs},&H00FFFFFF,1,5,0`,
      `Style: Sub,Arial,${subFs},&H00C8C8C8,0,2,${Math.round(height / 8)}`,
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Text',
      ...events,
    ].join('\n');
    const assPath = path.join(dir, 'card.ass');
    writeFileSync(assPath, ass, 'utf8');
    const outPath = path.join(dir, 'card.mp4');
    const res = spawnSync(
      FFMPEG_BIN,
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=c=${bg}:s=${width}x${height}:d=${seconds}`,
        '-r',
        '24',
        '-vf',
        `subtitles=${assPath}`,
        '-pix_fmt',
        'yuv420p',
        outPath,
      ],
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

function assSeconds(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  const sec = (s % 60).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2, '0')}:${sec}`;
}
