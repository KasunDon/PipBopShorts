import type { YoutubeClient } from '../clients/youtube';
import { UserInputError } from '../errors';
import type { Store } from '../store/store';
import type { Project, PublishSchedule } from '../types';
import { publishProject } from './publish';

/** Queue a publish to fire at a future time. Requires approved clips at fire time. */
export function schedulePublish(
  store: Store,
  storylineId: string,
  input: { at: string; privacyStatus?: 'public' | 'unlisted' | 'private'; stitch?: boolean },
  now: Date = new Date(),
): Project {
  const at = new Date(input.at);
  if (Number.isNaN(at.getTime())) throw new UserInputError('Invalid schedule time.');
  if (at.getTime() <= now.getTime()) throw new UserInputError('Schedule time must be in the future.');

  const project = store.getProject(storylineId);
  project.schedule = {
    at: at.toISOString(),
    privacyStatus: input.privacyStatus,
    stitch: input.stitch,
    status: 'pending',
    error: null,
    createdAt: now.toISOString(),
  };
  return store.saveProject(project);
}

/** Cancel a pending scheduled publish. */
export function cancelSchedule(store: Store, storylineId: string): Project {
  const project = store.getProject(storylineId);
  if (!project.schedule || project.schedule.status !== 'pending') {
    throw new UserInputError('No pending scheduled publish to cancel.');
  }
  project.schedule = { ...project.schedule, status: 'cancelled' };
  return store.saveProject(project);
}

export interface SchedulerDeps {
  store: Store;
  youtube: YoutubeClient;
  intervalMs?: number;
}

/**
 * Fires due scheduled publishes. `tick(now)` is pure enough to test with an
 * injected clock; `start()` just calls it on an interval. Publishing enforces
 * the approval gate, so a scheduled publish with unapproved clips fails cleanly
 * and records the reason rather than shipping unreviewed content.
 */
export class PublishScheduler {
  private readonly store: Store;
  private readonly youtube: YoutubeClient;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: SchedulerDeps) {
    this.store = deps.store;
    this.youtube = deps.youtube;
    this.intervalMs = deps.intervalMs ?? 30000;
  }

  /** Publish every pending schedule whose time has arrived. Returns how many fired. */
  async tick(now: Date = new Date()): Promise<number> {
    let fired = 0;
    for (const project of this.store.listProjects()) {
      const schedule = project.schedule;
      if (!schedule || schedule.status !== 'pending') continue;
      if (new Date(schedule.at).getTime() > now.getTime()) continue;
      fired += 1;
      await this.fire(project.storyline.id, schedule);
    }
    return fired;
  }

  private async fire(storylineId: string, schedule: PublishSchedule): Promise<void> {
    try {
      const record = await publishProject(this.store, this.youtube, storylineId, {
        privacyStatus: schedule.privacyStatus,
        stitch: schedule.stitch,
        requireApproval: true,
      });
      const project = this.store.getProject(storylineId);
      project.schedule = {
        ...schedule,
        status: record.status === 'published' ? 'published' : 'failed',
        error: record.error,
      };
      this.store.saveProject(project);
    } catch (err) {
      const project = this.store.getProject(storylineId);
      project.schedule = { ...schedule, status: 'failed', error: err instanceof Error ? err.message : String(err) };
      this.store.saveProject(project);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
