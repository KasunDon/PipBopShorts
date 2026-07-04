import { afterEach, describe, expect, it } from 'vitest';
import { addSceneComment, deleteSceneComment, setSceneCommentResolved } from '../src/services/comments';
import { createStorylineProject } from '../src/services/storyline';
import type { Store } from '../src/store/store';
import { makeFakeClaude, makeStore } from './helpers';

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

async function sceneOf(store: Store) {
  const story = store.createStory({ title: 'Notes', bible: '# Bible\nHero.' });
  const episode = store.createEpisode(story.id, { title: 'E1', brief: 'x' });
  const { client } = makeFakeClaude();
  const project = await createStorylineProject(store, client, story.id, episode.id, {});
  return { storylineId: project.storyline.id, sceneId: project.storyline.scenes[0].id };
}

describe('scene review comments', () => {
  it('adds, resolves, and deletes comments without touching the render', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const { storylineId, sceneId } = await sceneOf(store);

    let project = addSceneComment(store, storylineId, sceneId, 'Lighting feels flat here');
    let scene = project.storyline.scenes.find((s) => s.id === sceneId)!;
    expect(scene.comments).toHaveLength(1);
    expect(scene.comments![0].resolved).toBe(false);
    // Comment did not reset the (idle) clip.
    expect(project.clips[sceneId].status).toBe('idle');

    const commentId = scene.comments![0].id;
    project = setSceneCommentResolved(store, storylineId, sceneId, commentId, true);
    scene = project.storyline.scenes.find((s) => s.id === sceneId)!;
    expect(scene.comments![0].resolved).toBe(true);

    project = deleteSceneComment(store, storylineId, sceneId, commentId);
    scene = project.storyline.scenes.find((s) => s.id === sceneId)!;
    expect(scene.comments).toHaveLength(0);
  });

  it('rejects an empty comment and unknown ids', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const { storylineId, sceneId } = await sceneOf(store);
    expect(() => addSceneComment(store, storylineId, sceneId, '  ')).toThrow(/required/i);
    expect(() => setSceneCommentResolved(store, storylineId, sceneId, 'nope', true)).toThrow(/not found/i);
    expect(() => deleteSceneComment(store, storylineId, sceneId, 'nope')).toThrow(/not found/i);
  });
});
