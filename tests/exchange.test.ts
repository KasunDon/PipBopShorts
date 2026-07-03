import { afterEach, describe, expect, it } from 'vitest';
import { extractCanon } from '../src/services/canon';
import { exportFilename, exportStory, importStory, parseBlocks } from '../src/services/exchange';
import { createStorylineProject } from '../src/services/storyline';
import type { Store } from '../src/store/store';
import { makeStore, makeStudioFakeClaude } from './helpers';

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

/** Build a fully-populated story: meta, bible, 2 episodes (one with setting), canon, storyline. */
async function buildRichStory(store: Store) {
  const story = store.createStory({
    title: 'PipBop Pals',
    settingMode: 'per-episode',
    bible: '# Bible\nBobo is a golden-brown monkey with a bright green leaf scarf.',
    meta: { audienceMin: 4, audienceMax: 7, genres: ['comedy'], tones: ['cheerful'], format: '3D shorts' },
  });
  const { client } = makeStudioFakeClaude();
  await extractCanon(store, client, story.id);
  const ep1 = store.createEpisode(story.id, { title: 'Banana Boing', brief: 'Bobo wants a banana', setting: '# Frozen moon base' });
  const ep2 = store.createEpisode(story.id, { title: 'Berry Bubble', brief: 'Benny bites a berry' });
  const project = await createStorylineProject(store, client, story.id, ep1.id, {});
  return { story, ep1, ep2, project };
}

describe('export', () => {
  it('produces a self-describing .story.md package', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const { story } = await buildRichStory(store);

    const md = exportStory(store, story.id);
    expect(md).toContain('pipbopshorts-story-export v1');
    expect(md).toContain('# PipBop Pals — Story Package');
    expect(md).toContain('<!-- pipbop:story -->');
    expect(md).toContain('<!-- pipbop:bible -->');
    expect(md).toContain('green leaf scarf'); // bible content is raw markdown
    expect(md).toContain('## Episode: Banana Boing');
    expect(md).toContain('<!-- pipbop:episode-setting -->');
    expect(md).toContain('Frozen moon base');
    expect(md).toContain('### Storyline:');
    expect(md).toContain('## Canon Registry');
    expect(exportFilename(story)).toBe('pipbop-pals.story.md');
  });

  it('omits canon and settings sections when absent', () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const story = store.createStory({ title: 'Bare', bible: 'Just a bible.' });
    const md = exportStory(store, story.id);
    expect(md).not.toContain('<!-- pipbop:canon -->');
    expect(md).not.toContain('<!-- pipbop:episode -->');
  });
});

describe('import round-trip', () => {
  it('recreates the full story on a fresh store', async () => {
    const { store: source, cleanup: c1 } = makeStore();
    cleanups.push(c1);
    const { story, project } = await buildRichStory(source);
    const md = exportStory(source, story.id);

    const { store: target, cleanup: c2 } = makeStore();
    cleanups.push(c2);
    const result = importStory(target, md);

    // Story + meta
    expect(result.story.id).not.toBe(story.id); // fresh ids
    expect(result.story.title).toBe('PipBop Pals');
    expect(result.story.settingMode).toBe('per-episode');
    expect(result.story.meta.audienceMax).toBe(7);
    expect(result.story.meta.genres).toEqual(['comedy']);

    // Bible
    expect(target.getBible(result.story.id)).toContain('green leaf scarf');

    // Episodes + settings
    expect(result.episodes.map((e) => e.title)).toEqual(['Banana Boing', 'Berry Bubble']);
    expect(target.getSetting(result.episodes[0].id)).toContain('Frozen moon base');
    expect(target.getSetting(result.episodes[1].id)).toBe('');

    // Canon registry with full history, re-pointed at the new story
    const canon = target.getCanonRegistry(result.story.id)!;
    expect(canon.storyId).toBe(result.story.id);
    expect(canon.currentVersion).toBe(1);
    expect(canon.versions[0].entities.some((e) => e.id === 'CHAR_BOBO_001')).toBe(true);
    expect(result.canonVersions).toBe(1);

    // Storylines: scenes preserved, clips reset to idle, publish cleared
    expect(result.storylineCount).toBe(1);
    const projects = target.listProjectsByEpisode(result.episodes[0].id);
    expect(projects).toHaveLength(1);
    const imported = projects[0];
    expect(imported.storyline.scenes.map((s) => s.prompt)).toEqual(
      project.storyline.scenes.map((s) => s.prompt),
    );
    expect(imported.storyline.canonVersion).toBe(1);
    for (const scene of imported.storyline.scenes) {
      expect(imported.clips[scene.id].status).toBe('idle');
    }
    expect(imported.publish).toBeNull();
  });

  it('survives marker-lookalike text inside the bible', () => {
    const { store: source, cleanup: c1 } = makeStore();
    cleanups.push(c1);
    const tricky = 'Bible with a literal marker: <!-- pipbop:end --> inside prose.';
    const story = source.createStory({ title: 'Tricky', bible: tricky });
    const md = exportStory(source, story.id);

    const { store: target, cleanup: c2 } = makeStore();
    cleanups.push(c2);
    const result = importStory(target, md);
    expect(target.getBible(result.story.id)).toBe(tricky);
  });

  it('rejects non-package files', () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    expect(() => importStory(store, '# Just some markdown')).toThrow(/missing export header/i);
  });

  it('rejects packages from a newer format version', () => {
    const { store: source, cleanup: c1 } = makeStore();
    cleanups.push(c1);
    const story = source.createStory({ title: 'Future', bible: 'x' });
    const md = exportStory(source, story.id).replace('"formatVersion": 1', '"formatVersion": 99');
    const { store: target, cleanup: c2 } = makeStore();
    cleanups.push(c2);
    expect(() => importStory(target, md)).toThrow(/newer than this platform/i);
  });

  it('parseBlocks tolerates hand-edited whitespace in markers', () => {
    const md = '<!--  pipbop:bible  -->\nHello\n<!--  pipbop:end  -->';
    const blocks = parseBlocks(md);
    expect(blocks).toEqual([{ kind: 'bible', content: 'Hello' }]);
  });
});
