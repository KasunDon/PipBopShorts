import type { Store } from '../store/store';
import { currentCanonVersion } from './canon';

export interface StoryAnalytics {
  storyId: string;
  episodes: number;
  storylines: number;
  scenes: number;
  clips: { total: number; ready: number; approved: number };
  publishes: number;
  /** Total recorded views across this story's published shorts. */
  views: number;
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
  let views = 0;
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
    views += project.performance?.views ?? 0;
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
    views,
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

export interface StudioStorySummary {
  storyId: string;
  title: string;
  episodes: number;
  storylines: number;
  scenes: number;
  approvedClips: number;
  publishes: number;
  views: number;
  openDrifts: number;
  safetyDrifts: number;
  driftRate: number;
}
export interface StudioAnalytics {
  stories: number;
  episodes: number;
  storylines: number;
  scenes: number;
  approvedClips: number;
  publishes: number;
  views: number;
  openDrifts: number;
  safetyDrifts: number;
  /** Per-story rows, most safety-sensitive / most-drifting first so problems surface. */
  perStory: StudioStorySummary[];
}

/** Studio-wide roll-up across every story — the cross-IP dashboard. */
export function studioAnalytics(store: Store): StudioAnalytics {
  const totals: StudioAnalytics = {
    stories: 0,
    episodes: 0,
    storylines: 0,
    scenes: 0,
    approvedClips: 0,
    publishes: 0,
    views: 0,
    openDrifts: 0,
    safetyDrifts: 0,
    perStory: [],
  };

  for (const story of store.listStories()) {
    const a = storyAnalytics(store, story.id);
    totals.stories += 1;
    totals.episodes += a.episodes;
    totals.storylines += a.storylines;
    totals.scenes += a.scenes;
    totals.approvedClips += a.clips.approved;
    totals.publishes += a.publishes;
    totals.views += a.views;
    totals.openDrifts += a.drift.open;
    totals.safetyDrifts += a.drift.safety;
    totals.perStory.push({
      storyId: story.id,
      title: story.title,
      episodes: a.episodes,
      storylines: a.storylines,
      scenes: a.scenes,
      approvedClips: a.clips.approved,
      publishes: a.publishes,
      views: a.views,
      openDrifts: a.drift.open,
      safetyDrifts: a.drift.safety,
      driftRate: a.drift.driftRate,
    });
  }

  // Surface the riskiest first: safety findings, then open drifts, then drift rate.
  totals.perStory.sort(
    (x, y) => y.safetyDrifts - x.safetyDrifts || y.openDrifts - x.openDrifts || y.driftRate - x.driftRate,
  );
  return totals;
}
