import type { AuditEvent } from '../events/eventStore';
import { UserInputError } from '../errors';
import type { EpisodeSnapshot, Store, StorySnapshot } from '../store/store';
import type { Project, Scene } from '../types';
import { idleClip } from './storyline';

/** Audit event types whose preserved "before" snapshot is self-contained enough to restore. */
const RESTORABLE = new Set([
  'store.story.delete',
  'store.episode.delete',
  'store.storyline.delete',
  'store.scene.delete',
]);

export function isRestorable(event: { type: string }): boolean {
  return RESTORABLE.has(event.type);
}

export interface RestoreResult {
  kind: 'story' | 'episode' | 'storyline' | 'scene';
  id: string;
  label: string;
}

/**
 * Fail-safe restore: rehydrate a deleted storyline or scene from the old value
 * preserved in its `store` audit event. Only self-contained deletions are
 * supported — a deleted story/episode cascades into many records the single
 * event didn't capture, so those aren't offered here.
 */
export function restoreFromAudit(store: Store, event: AuditEvent): RestoreResult {
  const before = (event.request as { before?: unknown } | undefined)?.before;

  if (event.type === 'store.story.delete') {
    const snap = before as StorySnapshot | undefined;
    if (!snap?.story?.id) throw new UserInputError('This audit event has no story snapshot to restore.');
    if (store.hasStory(snap.story.id)) throw new UserInputError('This story already exists — nothing to restore.');
    const story = store.restoreStorySnapshot(snap);
    return { kind: 'story', id: story.id, label: story.title };
  }

  if (event.type === 'store.episode.delete') {
    const snap = before as EpisodeSnapshot | undefined;
    if (!snap?.episode?.id) throw new UserInputError('This audit event has no episode snapshot to restore.');
    if (store.hasEpisode(snap.episode.id)) throw new UserInputError('This episode already exists — nothing to restore.');
    try {
      store.getStory(snap.episode.storyId);
    } catch {
      throw new UserInputError('Cannot restore: the parent story no longer exists.');
    }
    const ep = store.restoreEpisodeSnapshot(snap);
    return { kind: 'episode', id: ep.id, label: ep.title };
  }

  if (event.type === 'store.storyline.delete') {
    const project = before as Project | undefined;
    if (!project?.storyline?.id) throw new UserInputError('This audit event has no storyline snapshot to restore.');
    // The parent episode must still exist so the restored storyline isn't orphaned.
    try {
      store.getEpisode(project.storyline.episodeId);
    } catch {
      throw new UserInputError('Cannot restore: the parent episode no longer exists.');
    }
    if (projectExists(store, project.storyline.id)) {
      throw new UserInputError('This storyline already exists — nothing to restore.');
    }
    store.saveProject(project);
    return { kind: 'storyline', id: project.storyline.id, label: project.storyline.title };
  }

  if (event.type === 'store.scene.delete') {
    const scene = before as Scene | undefined;
    const storylineId = event.context?.storylineId;
    if (!scene?.id || !storylineId) throw new UserInputError('This audit event has no scene snapshot to restore.');
    const project = store.getProject(storylineId); // 404 if the whole storyline is gone
    if (project.storyline.scenes.some((s) => s.id === scene.id)) {
      throw new UserInputError('This scene already exists — nothing to restore.');
    }
    // Re-insert at its original position, then renumber, so ordering stays stable.
    const scenes = [...project.storyline.scenes];
    const at = Math.min(Math.max(scene.order, 0), scenes.length);
    scenes.splice(at, 0, scene);
    scenes.forEach((s, i) => (s.order = i));
    project.storyline.scenes = scenes;
    project.clips[scene.id] = idleClip(scene.id); // a restored scene is unrendered
    store.saveProject(project);
    return { kind: 'scene', id: scene.id, label: scene.heading };
  }

  throw new UserInputError(`Restore is not supported for "${event.type}".`);
}

function projectExists(store: Store, storylineId: string): boolean {
  try {
    store.getProject(storylineId);
    return true;
  } catch {
    return false;
  }
}
