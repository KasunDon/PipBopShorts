import { UserInputError } from '../errors';
import type { Store } from '../store/store';
import { makeId } from '../store/store';
import type { Project, Scene, SceneComment } from '../types';

function getScene(store: Store, storylineId: string, sceneId: string): { project: Project; scene: Scene } {
  const project = store.getProject(storylineId);
  const scene = project.storyline.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new UserInputError(`Scene not found: ${sceneId}`);
  return { project, scene };
}

/** Add a review note to a scene. Comments are metadata — they never touch the render. */
export function addSceneComment(store: Store, storylineId: string, sceneId: string, text: string): Project {
  if (!text || !text.trim()) throw new UserInputError('Comment text is required.');
  const { project, scene } = getScene(store, storylineId, sceneId);
  const comment: SceneComment = {
    id: makeId('cmt'),
    text: text.trim(),
    resolved: false,
    createdAt: new Date().toISOString(),
  };
  scene.comments = [...(scene.comments ?? []), comment];
  return store.saveProject(project);
}

/** Toggle a comment's resolved state. */
export function setSceneCommentResolved(
  store: Store,
  storylineId: string,
  sceneId: string,
  commentId: string,
  resolved: boolean,
): Project {
  const { project, scene } = getScene(store, storylineId, sceneId);
  const comment = scene.comments?.find((c) => c.id === commentId);
  if (!comment) throw new UserInputError(`Comment not found: ${commentId}`);
  comment.resolved = resolved;
  return store.saveProject(project);
}

/** Delete a comment. */
export function deleteSceneComment(store: Store, storylineId: string, sceneId: string, commentId: string): Project {
  const { project, scene } = getScene(store, storylineId, sceneId);
  const before = scene.comments?.length ?? 0;
  scene.comments = (scene.comments ?? []).filter((c) => c.id !== commentId);
  if (scene.comments.length === before) throw new UserInputError(`Comment not found: ${commentId}`);
  return store.saveProject(project);
}
