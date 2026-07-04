import type { Store } from '../store/store';
import { currentCanonVersion } from './canon';

export interface StoryAnalytics {
  storyId: string;
  episodes: number;
  storylines: number;
  scenes: number;
  clips: { total: number; ready: number; approved: number };
  publishes: number;
  canon: { versions: number; entities: number; marks: number; lockedMarks: number };
  drift: {
    reports: number;
    findings: number;
    resolved: number;
    open: number;
    safety: number;
    /** open findings ÷ scenes — a rough "how much is drifting" signal. */
    driftRate: number;
  };
}

/**
 * Deterministic per-story production analytics for the studio dashboard: volume
 * (episodes/storylines/scenes/clips), publish + approval progress, canon
 * stability (versions/marks), and drift health (open vs resolved findings).
 */
export function storyAnalytics(store: Store, storyId: string): StoryAnalytics {
  store.getStory(storyId); // 404 if missing
  const episodes = store.listEpisodes(storyId);
  const projects = store.listProjects().filter((p) => p.storyline.storyId === storyId);

  let scenes = 0;
  let clipsTotal = 0;
  let clipsReady = 0;
  let clipsApproved = 0;
  let publishes = 0;
  let driftReports = 0;
  let driftFindings = 0;
  let driftResolved = 0;
  let driftSafety = 0;

  for (const project of projects) {
    scenes += project.storyline.scenes.length;
    for (const clip of Object.values(project.clips)) {
      clipsTotal += 1;
      if (clip.status === 'ready') clipsReady += 1;
      if (clip.approved) clipsApproved += 1;
    }
    publishes += (project.publishHistory ?? []).filter((p) => p.status === 'published').length;
    for (const report of project.driftReports ?? []) {
      driftReports += 1;
      for (const finding of report.findings) {
        driftFindings += 1;
        if (finding.resolution) driftResolved += 1;
        if (finding.category === 'safety') driftSafety += 1;
      }
    }
  }

  const canon = currentCanonVersion(store.getCanonRegistry(storyId));
  const registry = store.getCanonRegistry(storyId);
  const marks = canon ? canon.entities.reduce((n, e) => n + e.marks.length, 0) : 0;
  const lockedMarks = canon
    ? canon.entities.reduce((n, e) => n + e.marks.filter((m) => m.severity === 'locked').length, 0)
    : 0;
  const open = driftFindings - driftResolved;

  return {
    storyId,
    episodes: episodes.length,
    storylines: projects.length,
    scenes,
    clips: { total: clipsTotal, ready: clipsReady, approved: clipsApproved },
    publishes,
    canon: {
      versions: registry?.versions.length ?? 0,
      entities: canon?.entities.length ?? 0,
      marks,
      lockedMarks,
    },
    drift: {
      reports: driftReports,
      findings: driftFindings,
      resolved: driftResolved,
      open,
      safety: driftSafety,
      driftRate: scenes > 0 ? Number((open / scenes).toFixed(3)) : 0,
    },
  };
}
