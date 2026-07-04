import { EventEmitter } from 'node:events';
import type { PixverseClient } from '../clients/pixverse';
import type { Store } from '../store/store';
import { refreshClip } from './generation';
import { refreshPortrait } from './characters';

/**
 * Server-side background processing for long-running renders.
 *
 * A render is submitted asynchronously (`wait:false` → the HTTP request returns
 * immediately with the clip/portrait in `generating`), then tracked here. The
 * runner polls the provider on an interval **in the server process** — the
 * browser tab can close, the render still completes, stills still get captured,
 * and the store still updates. `resume()` re-tracks anything that was mid-render
 * across a server restart.
 *
 * Emits:
 * - `job` events (`queued` / `done`) for the SSE stream so open consoles get
 *   notified the moment something finishes.
 */

export type JobRef =
  | { kind: 'clip'; storylineId: string; sceneId: string }
  | { kind: 'portrait'; storyId: string; entityId: string; versionId: string };

export interface Job {
  id: string;
  kind: JobRef['kind'];
  ref: JobRef;
  /** Human-readable label for notifications (scene heading / character name). */
  label: string;
  addedAt: string;
  attempts: number;
}

export interface JobEvent {
  type: 'queued' | 'done';
  job: Job;
  /** Terminal status for `done` (ready | failed | moderation_failed | timed_out). */
  status: string;
  url?: string | null;
  error?: string | null;
  at: string;
}

export interface JobRunnerOptions {
  store: Store;
  pixverse: PixverseClient;
  /** Poll interval when started (ms). */
  intervalMs?: number;
  /** Give up after this many polls per job (safety valve). */
  maxAttempts?: number;
  /** Start the interval loop immediately. Tests use false and call tick(). */
  autoStart?: boolean;
}

function jobId(ref: JobRef): string {
  return ref.kind === 'clip' ? `clip:${ref.storylineId}:${ref.sceneId}` : `portrait:${ref.storyId}:${ref.entityId}:${ref.versionId}`;
}

export class JobRunner extends EventEmitter {
  private readonly store: Store;
  private readonly pixverse: PixverseClient;
  private readonly maxAttempts: number;
  private readonly intervalMs: number;
  private jobs = new Map<string, Job>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(options: JobRunnerOptions) {
    super();
    this.store = options.store;
    this.pixverse = options.pixverse;
    this.intervalMs = options.intervalMs ?? 5000;
    // Default ≈ 20 minutes at the default interval.
    this.maxAttempts = options.maxAttempts ?? 240;
    if (options.autoStart) this.start();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Never keep the process alive just to poll.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  pending(): Job[] {
    return [...this.jobs.values()];
  }

  /** Subscribe to job events; returns an unsubscribe function. */
  subscribe(listener: (event: JobEvent) => void): () => void {
    this.on('job', listener);
    return () => this.off('job', listener);
  }

  /** Track an in-flight render. Deduped — re-tracking the same render is a no-op. */
  track(ref: JobRef): Job {
    const id = jobId(ref);
    const existing = this.jobs.get(id);
    if (existing) return existing;
    const job: Job = {
      id,
      kind: ref.kind,
      ref,
      label: this.labelFor(ref),
      addedAt: new Date().toISOString(),
      attempts: 0,
    };
    this.jobs.set(id, job);
    this.emit('job', { type: 'queued', job, status: 'generating', at: new Date().toISOString() } satisfies JobEvent);
    return job;
  }

  /** Re-track everything that was mid-render (e.g. after a server restart). */
  resume(): number {
    let count = 0;
    for (const project of this.store.listProjects()) {
      for (const scene of project.storyline.scenes) {
        const clip = project.clips[scene.id];
        if (clip && clip.status === 'generating' && clip.videoId != null) {
          this.track({ kind: 'clip', storylineId: project.storyline.id, sceneId: scene.id });
          count += 1;
        }
      }
    }
    for (const story of this.store.listStories()) {
      const registry = this.store.getCharacterRegistry(story.id);
      if (!registry) continue;
      for (const asset of Object.values(registry.characters)) {
        for (const version of asset.versions) {
          if (version.status === 'generating' && version.videoId != null) {
            this.track({ kind: 'portrait', storyId: story.id, entityId: asset.entityId, versionId: version.id });
            count += 1;
          }
        }
      }
    }
    return count;
  }

  /** Poll every pending job once; terminal jobs are completed and removed. */
  async tick(): Promise<void> {
    if (this.ticking) return; // never overlap slow ticks
    this.ticking = true;
    try {
      for (const job of [...this.jobs.values()]) {
        job.attempts += 1;
        try {
          if (job.ref.kind === 'clip') {
            const clip = await refreshClip(this.store, this.pixverse, job.ref.storylineId, job.ref.sceneId);
            if (clip.status !== 'generating') {
              this.complete(job, clip.status, clip.url, clip.error);
              continue;
            }
          } else {
            const version = await refreshPortrait(this.store, this.pixverse, job.ref.storyId, job.ref.entityId, job.ref.versionId);
            if (version.status !== 'generating') {
              this.complete(job, version.status, version.previewUrl, version.error);
              continue;
            }
          }
        } catch (err) {
          // A transient poll failure shouldn't kill the job — the safety valve below caps retries.
          void err;
        }
        if (job.attempts >= this.maxAttempts) {
          this.complete(job, 'timed_out', null, 'Gave up waiting for the render to finish.');
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private complete(job: Job, status: string, url?: string | null, error?: string | null): void {
    this.jobs.delete(job.id);
    this.emit('job', { type: 'done', job, status, url: url ?? null, error: error ?? null, at: new Date().toISOString() } satisfies JobEvent);
  }

  private labelFor(ref: JobRef): string {
    try {
      if (ref.kind === 'clip') {
        const project = this.store.getProject(ref.storylineId);
        const idx = project.storyline.scenes.findIndex((s) => s.id === ref.sceneId);
        const scene = project.storyline.scenes[idx];
        return scene ? `Scene ${idx + 1} — ${scene.heading}` : 'Scene render';
      }
      const registry = this.store.getCharacterRegistry(ref.storyId);
      const name = registry?.characters[ref.entityId]?.name;
      return name ? `Reference — ${name}` : 'Reference render';
    } catch {
      return ref.kind === 'clip' ? 'Scene render' : 'Reference render';
    }
  }
}
