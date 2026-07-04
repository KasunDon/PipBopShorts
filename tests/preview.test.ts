import { afterEach, describe, expect, it } from 'vitest';
import { extractCanon } from '../src/services/canon';
import { buildStorylinePreview, validateStorylineForRender } from '../src/services/preview';
import { createStorylineProject, updateScene } from '../src/services/storyline';
import type { Store } from '../src/store/store';
import { makeStore, makeStudioFakeClaude, noSleep } from './helpers';

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

function storyWith(bible: string, brief: string): { store: Store; storyId: string; episodeId: string } {
  const { store, cleanup } = makeStore();
  cleanups.push(cleanup);
  const story = store.createStory({ title: 'Pals', bible, meta: { audienceMin: 4, audienceMax: 7 } });
  const ep = store.createEpisode(story.id, { title: 'E1', brief });
  return { store, storyId: story.id, episodeId: ep.id };
}

describe('storyline preview', () => {
  it('assembles the AI context and flags missing bible / canon', () => {
    const { store, storyId, episodeId } = storyWith('', '');
    const preview = buildStorylinePreview(store, storyId, episodeId);
    expect(preview.markdown).toContain('# Story: Pals');
    expect(preview.ok).toBe(false); // empty bible is an error
    expect(preview.checks.some((c) => c.level === 'error' && /bible is empty/i.test(c.message))).toBe(true);
    expect(preview.checks.some((c) => c.level === 'warn' && /brief is empty/i.test(c.message))).toBe(true);
    expect(preview.checks.some((c) => c.level === 'warn' && /No canon/i.test(c.message))).toBe(true);
  });

  it('passes checks and includes canon once bible + brief + canon exist', async () => {
    const { store, storyId, episodeId } = storyWith(
      '# Bible\nBobo is a golden-brown monkey with a bright green leaf scarf who explores the grove and helps his friends.',
      'Bobo chases a runaway kite across the grove.',
    );
    const { client } = makeStudioFakeClaude();
    await extractCanon(store, client, storyId);

    const preview = buildStorylinePreview(store, storyId, episodeId);
    expect(preview.ok).toBe(true);
    expect(preview.markdown).toContain('Bobo chases a runaway kite');
    expect(preview.markdown).toMatch(/Canon \(v1\)/);
    expect(preview.checks.some((c) => c.level === 'ok' && /Canon v1/.test(c.message))).toBe(true);
  });
});

describe('render validation + cost estimate', () => {
  it('estimates total render cost and reports valid scenes', async () => {
    const { store, storyId, episodeId } = storyWith('# Bible\nBobo the monkey.', 'Bobo climbs.');
    const { client } = makeStudioFakeClaude();
    const project = await createStorylineProject(store, client, storyId, episodeId, {});

    const validation = validateStorylineForRender(store, project.storyline.id);
    expect(validation.scenes.length).toBe(project.storyline.scenes.length);
    expect(validation.ok).toBe(true);
    expect(validation.totalCredits).toBeGreaterThan(0);
    expect(validation.totalUsd).toBeGreaterThan(0);
    expect(validation.estUsdLabel).toMatch(/^\$/);
  });

  it('flags a scene whose parameters violate PixVerse rules', async () => {
    const { store, storyId, episodeId } = storyWith('# Bible\nBobo.', 'x');
    const { client } = makeStudioFakeClaude();
    const project = await createStorylineProject(store, client, storyId, episodeId, {});
    const sceneId = project.storyline.scenes[0].id;
    // 1080p + 8s is an invalid combination (1080p capped at 5s).
    updateScene(store, project.storyline.id, sceneId, { quality: '1080p', duration: 5 });
    // Force an invalid duration directly via the store to exercise validation.
    const p = store.getProject(project.storyline.id);
    p.storyline.scenes[0].quality = '1080p';
    p.storyline.scenes[0].duration = 8;
    store.saveProject(p);

    const validation = validateStorylineForRender(store, project.storyline.id);
    expect(validation.ok).toBe(false);
    expect(validation.invalidCount).toBeGreaterThan(0);
    expect(validation.scenes.find((s) => s.sceneId === sceneId)?.issues.length).toBeGreaterThan(0);
  });

  it('noSleep helper stays importable', () => {
    expect(typeof noSleep).toBe('function');
  });
});
