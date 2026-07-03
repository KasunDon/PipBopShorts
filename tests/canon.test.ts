import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCanonBlock,
  currentCanonVersion,
  extractCanon,
  patchMark,
} from '../src/services/canon';
import { createStorylineProject } from '../src/services/storyline';
import { episodeSettingTemplate, storyBibleTemplate } from '../src/templates';
import type { Store } from '../src/store/store';
import { makeStore, makeStudioFakeClaude } from './helpers';

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

function setup(withMeta = true): { store: Store; storyId: string } {
  const { store, cleanup } = makeStore();
  cleanups.push(cleanup);
  const story = store.createStory({
    title: 'PipBop Pals',
    bible: '# Bible\nBobo is a golden-brown monkey with a bright green leaf scarf.',
    meta: withMeta
      ? {
          audienceMin: 4,
          audienceMax: 7,
          genres: ['comedy', 'adventure'],
          tones: ['cheerful', 'safe'],
          format: '3D animated comedy shorts',
        }
      : undefined,
  });
  return { store, storyId: story.id };
}

describe('templates', () => {
  it('story bible template captures all vital sections', () => {
    const md = storyBibleTemplate('My Series', { audienceMin: 4, audienceMax: 7, genres: ['comedy'] });
    for (const section of [
      'Premise',
      'Audience & Tone',
      'World / Setting',
      'Main Characters',
      'Visual signature',
      'Never change',
      'Relationships',
      'Recurring Locations',
      'Story Formula',
      'Do / Don\'t',
      'Consistency Prompt Reference',
    ]) {
      expect(md).toContain(section);
    }
    expect(md).toContain('Ages 4–7');
    expect(md).toContain('comedy');
  });

  it('episode setting template covers overrides and consistency', () => {
    const md = episodeSettingTemplate('Ep 5');
    expect(md).toContain('Ep 5 — Episode Setting');
    expect(md).toContain('Must keep consistent');
    expect(md).toContain('One-off characters or props');
  });
});

describe('canon extraction', () => {
  it('creates v1 with asset-style ids and marks', async () => {
    const { store, storyId } = setup();
    const { client, calls } = makeStudioFakeClaude();
    const registry = await extractCanon(store, client, storyId);

    expect(registry.currentVersion).toBe(1);
    expect(registry.versions).toHaveLength(1);
    const v1 = registry.versions[0];
    expect(v1.source).toBe('extraction');
    expect(v1.model).toBe('claude-sonnet-5'); // default dissect model
    const bobo = v1.entities.find((e) => e.name === 'Bobo')!;
    expect(bobo.id).toBe('CHAR_BOBO_001');
    expect(bobo.marks.find((m) => m.key === 'scarf')?.severity).toBe('locked');
    expect(v1.negativePrompt).toContain('violence');

    // Extraction prompt included the bible and declared metadata.
    const user = (calls[0].params.messages as Array<{ content: string }>)[0].content;
    expect(user).toContain('green leaf scarf');
    expect(user).toContain('ages 4–7');
  });

  it('auto-creates audience/tone marks from story metadata', async () => {
    const { store, storyId } = setup();
    const { client } = makeStudioFakeClaude();
    const registry = await extractCanon(store, client, storyId);
    const aud = registry.versions[0].entities.find((e) => e.type === 'audience_tone')!;
    expect(aud).toBeTruthy();
    const target = aud.marks.find((m) => m.key === 'target_audience')!;
    expect(target.value).toContain('4–7');
    expect(target.severity).toBe('locked');
    expect(aud.marks.find((m) => m.key === 'genres')?.value).toContain('comedy');
    expect(aud.marks.find((m) => m.key === 'tone')?.value).toContain('cheerful');
  });

  it('supports overriding the dissection model', async () => {
    const { store, storyId } = setup();
    const { client, calls } = makeStudioFakeClaude();
    await extractCanon(store, client, storyId, { model: 'claude-opus-4-8' });
    expect(calls[0].params.model).toBe('claude-opus-4-8');
  });

  it('re-extraction bumps the version and keeps history', async () => {
    const { store, storyId } = setup();
    const { client } = makeStudioFakeClaude();
    await extractCanon(store, client, storyId);
    const registry = await extractCanon(store, client, storyId, { note: 'after bible edit' });
    expect(registry.currentVersion).toBe(2);
    expect(registry.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(registry.versions[1].note).toBe('after bible edit');
  });

  it('rejects an empty bible', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const story = store.createStory({ title: 'Empty', bible: '   ' });
    const { client } = makeStudioFakeClaude();
    await expect(extractCanon(store, client, story.id)).rejects.toThrow(/bible is empty/i);
  });
});

describe('canon block + versioned edits', () => {
  it('builds a deterministic canon block with severities and negative prompt', async () => {
    const { store, storyId } = setup();
    const { client } = makeStudioFakeClaude();
    const registry = await extractCanon(store, client, storyId);
    const block = buildCanonBlock(currentCanonVersion(registry)!);
    expect(block).toContain('character: Bobo (CHAR_BOBO_001)');
    expect(block).toContain('[LOCKED] scarf: bright green leaf scarf');
    expect(block).toContain('Global negative prompt');
  });

  it('patchMark creates a new version and preserves history', async () => {
    const { store, storyId } = setup();
    const { client } = makeStudioFakeClaude();
    await extractCanon(store, client, storyId);
    const registry = patchMark(store, storyId, 'CHAR_BOBO_001', 'scarf', {
      value: 'bright blue leaf scarf',
      note: 'brand refresh',
    });
    expect(registry.currentVersion).toBe(2);
    const v2 = currentCanonVersion(registry)!;
    expect(v2.source).toBe('manual');
    expect(v2.entities.find((e) => e.id === 'CHAR_BOBO_001')!.marks.find((m) => m.key === 'scarf')!.value).toBe(
      'bright blue leaf scarf',
    );
    // v1 untouched.
    const v1 = registry.versions.find((v) => v.version === 1)!;
    expect(v1.entities.find((e) => e.id === 'CHAR_BOBO_001')!.marks.find((m) => m.key === 'scarf')!.value).toBe(
      'bright green leaf scarf',
    );
  });

  it('starts and completes a gradual transition', async () => {
    const { store, storyId } = setup();
    const { client } = makeStudioFakeClaude();
    await extractCanon(store, client, storyId);

    let registry = patchMark(store, storyId, 'CHAR_BOBO_001', 'scarf', {
      status: 'transitioning',
      transitionTo: 'teal explorer scarf',
      note: 'gradual redesign',
    });
    let mark = currentCanonVersion(registry)!.entities.find((e) => e.id === 'CHAR_BOBO_001')!.marks.find(
      (m) => m.key === 'scarf',
    )!;
    expect(mark.status).toBe('transitioning');
    expect(mark.transition).toMatchObject({ from: 'bright green leaf scarf', to: 'teal explorer scarf' });

    const block = buildCanonBlock(currentCanonVersion(registry)!);
    expect(block).toContain('TRANSITIONING');
    expect(block).toContain('teal explorer scarf');

    // Completing the transition adopts the target value.
    registry = patchMark(store, storyId, 'CHAR_BOBO_001', 'scarf', { status: 'active' });
    mark = currentCanonVersion(registry)!.entities.find((e) => e.id === 'CHAR_BOBO_001')!.marks.find(
      (m) => m.key === 'scarf',
    )!;
    expect(mark.status).toBe('active');
    expect(mark.value).toBe('teal explorer scarf');
    expect(mark.transition).toBeNull();
    expect(registry.currentVersion).toBe(3);
  });
});

describe('canon-aware storyline generation', () => {
  it('injects the canon block, records the version, and merges the negative prompt', async () => {
    const { store, storyId } = setup();
    const { client, calls } = makeStudioFakeClaude();
    await extractCanon(store, client, storyId);
    const episode = store.createEpisode(storyId, { title: 'Ep 1', brief: 'Bobo wants a banana' });

    const project = await createStorylineProject(store, client, storyId, episode.id, {});

    // Last call is the storyline generation; its prompt carries the canon.
    const gen = calls[calls.length - 1];
    const user = (gen.params.messages as Array<{ content: string }>)[0].content;
    expect(user).toContain('CANON (version-controlled consistency marks');
    expect(user).toContain('[LOCKED] scarf: bright green leaf scarf');
    expect(String(gen.params.system)).toContain('Canon discipline');
    expect(String(gen.params.system)).toContain('Child-audience discipline');

    expect(project.storyline.canonVersion).toBe(1);
    for (const scene of project.storyline.scenes) {
      expect(scene.negativePrompt).toContain('photorealism'); // merged from canon
      expect(scene.negativePrompt).toContain('watermark'); // original kept
    }
  });

  it('generates without canon when none exists (canonVersion null)', async () => {
    const { store, storyId } = setup();
    const { client, calls } = makeStudioFakeClaude();
    const episode = store.createEpisode(storyId, { title: 'Ep 1', brief: 'x' });
    const project = await createStorylineProject(store, client, storyId, episode.id, {});
    expect(project.storyline.canonVersion).toBeNull();
    const user = (calls[0].params.messages as Array<{ content: string }>)[0].content;
    expect(user).not.toContain('CANON (version-controlled');
    // Metadata still steers generation.
    expect(user).toContain('Audience: ages 4–7');
  });
});
