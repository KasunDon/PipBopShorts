import { afterEach, describe, expect, it } from 'vitest';
import { buildCaptionsSrt } from '../src/services/captions';
import { localizeCaptionsSrt } from '../src/services/captionsLocalize';
import { planStorylineDialogue } from '../src/services/dialogue';
import { createStorylineProject, updateScene } from '../src/services/storyline';
import type { Store } from '../src/store/store';
import { makeFakeClaude, makeStore, makeStudioFakeClaude } from './helpers';

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

async function project(store: Store) {
  const story = store.createStory({ title: 'Caps', bible: '# Bible\nHero.' });
  const episode = store.createEpisode(story.id, { title: 'E1', brief: 'x' });
  const { client } = makeFakeClaude();
  const p = await createStorylineProject(store, client, story.id, episode.id, {});
  return p.storyline.id;
}

describe('captions / subtitles', () => {
  it('planning dialogue persists captions and builds a timed SRT', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const storylineId = await project(store);
    // Default sample storyline scenes are 5s each.
    const { client } = makeStudioFakeClaude(); // routes dialogue → sampleDialogueJson (2 scenes)
    await planStorylineDialogue(store, client, storylineId);

    const srt = buildCaptionsSrt(store, storylineId);
    expect(srt).toContain('00:00:00,000 --> 00:00:05,000');
    expect(srt).toContain('A neon night begins!');
    // Second caption starts where the first ends.
    expect(srt).toContain('00:00:05,000 --> 00:00:10,000');
  });

  it('skips scenes without a caption but keeps the clock advancing', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const storylineId = await project(store);
    const scenes = store.getProject(storylineId).storyline.scenes;
    // Caption only the second scene.
    updateScene(store, storylineId, scenes[1].id, { caption: 'Only me' });

    const srt = buildCaptionsSrt(store, storylineId);
    expect(srt).toContain('Only me');
    // It's timed from 5s (after the first uncaptioned 5s scene), not 0s.
    expect(srt).toContain('00:00:05,000 --> 00:00:10,000');
    expect(srt.startsWith('1\n')).toBe(true);
  });

  it('localizes captions into a timed SRT in another language', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const storylineId = await project(store);
    const { client } = makeStudioFakeClaude();
    await planStorylineDialogue(store, client, storylineId); // persists 2 captions

    const srt = await localizeCaptionsSrt(store, client, storylineId, 'Spanish');
    expect(srt).toContain('ES caption 1');
    expect(srt).toContain('00:00:00,000 --> 00:00:05,000');
  });
});
