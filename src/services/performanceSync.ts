import type { AnalyticsSource } from '../clients/youtube';
import type { Store } from '../store/store';

export interface SyncResult {
  updated: number;
  /** Storylines skipped because they aren't published or analytics weren't available. */
  skipped: number;
}

/**
 * Pull real performance for a story's published shorts from an analytics source
 * and record it on each storyline. The source no-ops (returns null) until the
 * YouTube Analytics API is configured, so this is safe to call anytime.
 */
export async function syncPerformance(store: Store, source: AnalyticsSource, storyId: string): Promise<SyncResult> {
  store.getStory(storyId);
  let updated = 0;
  let skipped = 0;

  for (const project of store.listProjects()) {
    if (project.storyline.storyId !== storyId) continue;
    const videoId = project.publish?.videoId;
    if (project.publish?.status !== 'published' || !videoId) {
      skipped += 1;
      continue;
    }
    const analytics = await source.fetchAnalytics(videoId);
    if (!analytics) {
      skipped += 1;
      continue;
    }
    project.performance = {
      views: analytics.views,
      retentionPct: analytics.avgViewPct,
      likes: analytics.likes,
      note: 'Synced from analytics',
      recordedAt: new Date().toISOString(),
    };
    store.saveProject(project);
    updated += 1;
  }

  return { updated, skipped };
}
