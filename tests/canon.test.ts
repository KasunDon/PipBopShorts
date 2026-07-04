import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCanonBlock,
  currentCanonVersion,
  diffCanonVersions,
  extractCanon,
  patchMark,
} from '../src/services/canon';
import { checkDrift, resolveDrift } from '../src/services/drift';
import { createStorylineProject } from '../src/services/storyline';
import type { CanonVersion } from '../src/types';
import { makeStore, makeStudioFakeClaude } from './helpers';

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

/** A story with canon extracted and one storyline generated against it. */
async function studioWithCanon(driftJson?: string) {
  const { store, cleanup } = makeStore();
  cleanups.push(cleanup);
  const story = store.createStory({
    title: 'PipBop Pals',
    bible: '# Bible\nBobo wears a bright green leaf scarf.',
    meta: { audienceMin: 4, audienceMax: 7 },
  });
  const { client } = makeStudioFakeClaude(driftJson !== undefined ? { driftJson } : undefined);
  await extractCanon(store, client, story.id);
  const episode = store.createEpisode(story.id, { title: 'E1', brief: 'banana quest' });
  const project = await createStorylineProject(store, client, story.id, episode.id, {});
  return { store, client, storyId: story.id, storylineId: project.storyline.id };
}

describe('canon extraction and versioning', () => {
  it('dissects the bible into version-controlled marks with stable ids', async () => {
    const { store, storyId } = await studioWithCanon();
    const canon = currentCanonVersion(store.getCanonRegistry(storyId))!;
    expect(canon.version).toBe(1);
    const bobo = canon.entities.find((e) => e.id === 'CHAR_BOBO_001')!;
    expect(bobo.marks.find((m) => m.key === 'scarf')?.value).toContain('green');
  });

  it('editing a mark creates a new version; a gradual change instructs future blends', async () => {
    const { store, storyId } = await studioWithCanon();
    const registry = patchMark(store, storyId, 'CHAR_BOBO_001', 'scarf', { value: 'red woolly scarf' });
    expect(registry.currentVersion).toBe(2);

    patchMark(store, storyId, 'CHAR_BOBO_001', 'scarf', { status: 'transitioning', transitionTo: 'blue scarf' });
    const block = buildCanonBlock(currentCanonVersion(store.getCanonRegistry(storyId))!);
    expect(block).toContain('blend toward the new value');
  });
});

describe('canon diff', () => {
  const mark = (key: string, value: string, severity = 'strong') => ({
    key,
    value,
    severity: severity as 'locked' | 'strong' | 'flexible',
    status: 'active' as const,
    transition: null,
    rationale: '',
  });
  const version = (n: number, entities: CanonVersion['entities']): CanonVersion => ({
    version: n,
    createdAt: '2026-01-01T00:00:00Z',
    source: 'manual',
    model: null,
    note: '',
    entities,
    negativePrompt: '',
  });

  it('reports added/removed entities and per-mark value changes', () => {
    const v1 = version(1, [
      { id: 'CHAR_BOBO_001', type: 'character', name: 'Bobo', summary: '', marks: [mark('scarf', 'green')] },
      { id: 'LOC_TREE_001', type: 'location', name: 'Tree', summary: '', marks: [] },
    ]);
    const v2 = version(2, [
      { id: 'CHAR_BOBO_001', type: 'character', name: 'Bobo', summary: '', marks: [mark('scarf', 'red')] },
      { id: 'CHAR_RIZZO_001', type: 'character', name: 'Rizzo', summary: '', marks: [] },
    ]);
    const diff = diffCanonVersions(v1, v2);
    expect(diff.entitiesAdded.map((e) => e.name)).toEqual(['Rizzo']);
    expect(diff.entitiesRemoved.map((e) => e.name)).toEqual(['Tree']);
    expect(diff.changes.find((c) => c.markKey === 'scarf')).toMatchObject({ before: 'green', after: 'red' });
  });
});

describe('drift detection and resolution', () => {
  it('requires canon to exist', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const { client } = makeStudioFakeClaude();
    const story = store.createStory({ title: 'NoCanon' });
    const episode = store.createEpisode(story.id, { title: 'E' });
    const project = await createStorylineProject(store, client, story.id, episode.id, {});
    await expect(checkDrift(store, client, project.storyline.id)).rejects.toThrow(/extract canon first/i);
  });

  it('maps findings to canon entities and the scenes involved', async () => {
    const { store, client, storylineId } = await studioWithCanon();
    const report = await checkDrift(store, client, storylineId);
    const scarf = report.findings[0];
    expect(scarf.entityId).toBe('CHAR_BOBO_001');
    expect(scarf.severity).toBe('high');
    expect(scarf.sceneIds[0]).toBe(store.getProject(storylineId).storyline.scenes[0].id);
  });

  it('feeds the audience + a child-safety directive into the drift check', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const story = store.createStory({ title: 'Kids', bible: '# Bible\nBobo.', meta: { audienceMin: 4, audienceMax: 7 } });
    const { client, calls } = makeStudioFakeClaude();
    await extractCanon(store, client, story.id);
    const episode = store.createEpisode(story.id, { title: 'E1', brief: 'x' });
    const project = await createStorylineProject(store, client, story.id, episode.id, {});
    await checkDrift(store, client, project.storyline.id);

    const driftCall = calls.find((c) => String(c.params.system).includes('report every drift'))!;
    const user = String((driftCall.params.messages as Array<{ content: string }>)[0].content);
    expect(user).toContain('CHILD-SAFETY MODE: ON');
  });

  it('accept-now promotes the observed value into a new canon version', async () => {
    const { store, client, storyId, storylineId } = await studioWithCanon();
    const report = await checkDrift(store, client, storylineId);
    resolveDrift(store, storylineId, report.id, report.findings[0].id, 'accept-now');
    const mark = currentCanonVersion(store.getCanonRegistry(storyId))!
      .entities.find((e) => e.id === 'CHAR_BOBO_001')!
      .marks.find((m) => m.key === 'scarf')!;
    expect(mark.value).toBe('red woolly scarf');
  });

  it('reject records the resolution and leaves canon untouched', async () => {
    const { store, client, storyId, storylineId } = await studioWithCanon();
    const report = await checkDrift(store, client, storylineId);
    const result = resolveDrift(store, storylineId, report.id, report.findings[0].id, 'reject');
    expect(result.finding.resolution?.action).toBe('reject');
    expect(store.getCanonRegistry(storyId)!.currentVersion).toBe(1);
  });
});
