import type { PixverseClient } from '../clients/pixverse';
import type { YoutubeClient } from '../clients/youtube';
import { UserInputError } from '../errors';
import type { Store } from '../store/store';
import type { Clip, Project, PublishSchedule } from '../types';
import { generateAllClips, type GenerateOptions } from './generation';
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

function validateFuture(atInput: string, now: Date): string {
  const at = new Date(atInput);
  if (Number.isNaN(at.getTime())) throw new UserInputError('Invalid schedule time.');
  if (at.getTime() <= now.getTime()) throw new UserInputError('Schedule time must be in the future.');
  return at.toISOString();
}

/** Queue a full storyline render for a future time. */
export function scheduleRender(store: Store, storylineId: string, at: string, now: Date = new Date()): Project {
  const iso = validateFuture(at, now);
  const project = store.getProject(storylineId);
  project.renderSchedule = { at: iso, status: 'pending', error: null, createdAt: now.toISOString() };
  return store.saveProject(project);
}

/** Cancel a pending scheduled render run. */
export function cancelRenderSchedule(store: Store, storylineId: string): Project {
  const project = store.getProject(storylineId);
  if (!project.renderSchedule || project.renderSchedule.status !== 'pending') {
    throw new UserInputError('No pending scheduled render to cancel.');
  }
  project.renderSchedule = { ...project.renderSchedule, status: 'cancelled' };
  return store.saveProject(project);
}

export interface SchedulerDeps {
  store: Store;
  youtube: YoutubeClient;
  /** Required to fire scheduled render runs. */
  pixverse?: PixverseClient;
  /** Called for each clip a scheduled render submits, so the JobRunner can track it. */
  onClipSubmitted?: (storylineId: string, clip: Clip) => void;
  /** Generation defaults (tests inject a fast poll). */
  generateDefaults?: Omit<GenerateOptions, 'wait'>;
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
  private readonly pixverse?: PixverseClient;
  private readonly onClipSubmitted?: (storylineId: string, clip: Clip) => void;
  private readonly generateDefaults?: Omit<GenerateOptions, 'wait'>;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: SchedulerDeps) {
    this.store = deps.store;
    this.youtube = deps.youtube;
    this.pixverse = deps.pixverse;
    this.onClipSubmitted = deps.onClipSubmitted;
    this.generateDefaults = deps.generateDefaults;
    this.intervalMs = deps.intervalMs ?? 30000;
  }

  /** Fire every due schedule (render runs, then publishes). Returns how many fired. */
  async tick(now: Date = new Date()): Promise<number> {
    let fired = 0;
    for (const project of this.store.listProjects()) {
      const render = project.renderSchedule;
      if (render && render.status === 'pending' && new Date(render.at).getTime() <= now.getTime()) {
        fired += 1;
        await this.fireRender(project.storyline.id, render);
      }
      const schedule = project.schedule;
      if (schedule && schedule.status === 'pending' && new Date(schedule.at).getTime() <= now.getTime()) {
        fired += 1;
        await this.fire(project.storyline.id, schedule);
      }
    }
    return fired;
  }

  private async fireRender(storylineId: string, schedule: import('../types').RenderSchedule): Promise<void> {
    try {
      if (!this.pixverse) throw new Error('No renderer configured for scheduled renders.');
      // Submit async — the JobRunner completes the clips server-side.
      const project = await generateAllClips(this.store, this.pixverse, storylineId, {
        ...this.generateDefaults,
        wait: false,
      });
      for (const clip of Object.values(project.clips)) this.onClipSubmitted?.(storylineId, clip);
      const fresh = this.store.getProject(storylineId);
      fresh.renderSchedule = { ...schedule, status: 'started', error: null };
      this.store.saveProject(fresh);
    } catch (err) {
      const project = this.store.getProject(storylineId);
      project.renderSchedule = { ...schedule, status: 'failed', error: err instanceof Error ? err.message : String(err) };
      this.store.saveProject(project);
    }
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
