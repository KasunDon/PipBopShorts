import { afterEach, describe, expect, it } from 'vitest';
import { currentCanonVersion, extractCanon } from '../src/services/canon';
import { checkDrift, resolveDrift } from '../src/services/drift';
import { createStorylineProject } from '../src/services/storyline';
import type { Store } from '../src/store/store';
import { makeStore, makeStudioFakeClaude } from './helpers';
import type { AnthropicLike } from '../src/clients/claude';

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

async function setup(driftJson?: string): Promise<{
  store: Store;
  client: AnthropicLike;
  storyId: string;
  storylineId: string;
}> {
  const { store, cleanup } = makeStore();
  cleanups.push(cleanup);
  const story = store.createStory({
    title: 'PipBop Pals',
    bible: '# Bible\nBobo wears a bright green leaf scarf.',
    meta: { audienceMin: 4, audienceMax: 7 },
  });
  const { client } = makeStudioFakeClaude(driftJson !== undefined ? { driftJson } : undefined);
  await extractCanon(store, client, story.id);
  const episode = store.createEpisode(story.id, { title: 'Ep 1', brief: 'banana quest' });
  const project = await createStorylineProject(store, client, story.id, episode.id, {});
  return { store, client, storyId: story.id, storylineId: project.storyline.id };
}

describe('drift detection', () => {
  it('requires canon to exist', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const story = store.createStory({ title: 'NoCanon' });
    const { client } = makeStudioFakeClaude();
    const ep = store.createEpisode(story.id, { title: 'E' });
    const project = await createStorylineProject(store, client, story.id, ep.id, {});
    await expect(checkDrift(store, client, project.storyline.id)).rejects.toThrow(/extract canon first/i);
  });

  it('produces a report mapped to canon entities and scene ids', async () => {
    const { store, client, storylineId } = await setup();
    const report = await checkDrift(store, client, storylineId);

    expect(report.canonVersion).toBe(1);
    expect(report.model).toBe('claude-sonnet-5');
    expect(report.findings).toHaveLength(2);

    const scarf = report.findings[0];
    expect(scarf.entityId).toBe('CHAR_BOBO_001');
    expect(scarf.severity).toBe('high');
    expect(scarf.observed).toBe('red woolly scarf');
    const project = store.getProject(storylineId);
    expect(scarf.sceneIds[0]).toBe(project.storyline.scenes[0].id);

    // Persisted on the project.
    expect(project.driftReports).toHaveLength(1);
    expect(project.driftReports![0].id).toBe(report.id);
  });

  it('supports a clean report', async () => {
    const clean = JSON.stringify({ summary: 'No drift found.', findings: [] });
    const { store, client, storylineId } = await setup(clean);
    const report = await checkDrift(store, client, storylineId);
    expect(report.findings).toHaveLength(0);
  });
});

describe('tone & child-safety consistency', () => {
  it('injects audience/tone context and CHILD-SAFETY MODE for a young audience, and maps safety findings', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const story = store.createStory({
      title: 'PipBop Pals',
      bible: '# Bible\nBobo wears a bright green leaf scarf.',
      meta: { audienceMin: 4, audienceMax: 7, tones: ['gentle', 'cheerful'] },
    });
    const safetyDrift = JSON.stringify({
      summary: 'A scary moment slipped in.',
      findings: [
        {
          entity_name: 'Audience & Tone',
          mark_key: 'child_safety',
          expected: 'gentle, cheerful; nothing scary for ages 4–7',
          observed: 'a looming shadow monster frightens Bobo in the dark',
          scene_numbers: [1],
          severity: 'high',
          category: 'safety',
          explanation: 'A frightening monster in the dark is inappropriate for a 4–7 audience.',
          suggestion: 'Replace the monster with a friendly surprise, or brighten the scene.',
        },
      ],
    });
    const { client, calls } = makeStudioFakeClaude({ driftJson: safetyDrift });
    await extractCanon(store, client, story.id);
    const episode = store.createEpisode(story.id, { title: 'Ep 1', brief: 'night walk' });
    const project = await createStorylineProject(store, client, story.id, episode.id, {});

    const report = await checkDrift(store, client, project.storyline.id);
    expect(report.findings[0].category).toBe('safety');
    expect(report.findings[0].severity).toBe('high');

    // The drift LLM call actually received the audience + child-safety context.
    const driftCall = calls.find((c) => String(c.params.system).includes('report every drift'))!;
    const userMsg = String((driftCall.params.messages as Array<{ content: string }>)[0].content);
    expect(userMsg).toContain('AUDIENCE & TONE');
    expect(userMsg).toContain('ages 4–7');
    expect(userMsg).toContain('gentle, cheerful');
    expect(userMsg).toContain('CHILD-SAFETY MODE: ON');
  });

  it('omits child-safety mode for an adult audience', async () => {
    const { store, cleanup } = makeStore();
    cleanups.push(cleanup);
    const story = store.createStory({
      title: 'Late Night Noir',
      bible: '# Bible\nA detective in a rain-soaked city.',
      meta: { audienceMin: 18, audienceMax: 40, tones: ['moody'] },
    });
    const { client, calls } = makeStudioFakeClaude({ driftJson: JSON.stringify({ summary: 'ok', findings: [] }) });
    await extractCanon(store, client, story.id);
    const episode = store.createEpisode(story.id, { title: 'Ep 1', brief: 'stakeout' });
    const project = await createStorylineProject(store, client, story.id, episode.id, {});

    await checkDrift(store, client, project.storyline.id);
    const driftCall = calls.find((c) => String(c.params.system).includes('report every drift'))!;
    const userMsg = String((driftCall.params.messages as Array<{ content: string }>)[0].content);
    expect(userMsg).toContain('AUDIENCE & TONE');
    expect(userMsg).not.toContain('CHILD-SAFETY MODE');
  });
});

describe('drift resolution', () => {
  it('accept-now promotes the observed value into a new canon version', async () => {
    const { store, client, storyId, storylineId } = await setup();
    const report = await checkDrift(store, client, storylineId);
    const finding = report.findings[0];

    const result = resolveDrift(store, storylineId, report.id, finding.id, 'accept-now', 'ship it');
    expect(result.finding.resolution?.action).toBe('accept-now');
    expect(result.finding.resolution?.canonVersion).toBe(2);

    const canon = currentCanonVersion(store.getCanonRegistry(storyId))!;
    const mark = canon.entities.find((e) => e.id === 'CHAR_BOBO_001')!.marks.find((m) => m.key === 'scarf')!;
    expect(mark.value).toBe('red woolly scarf');
    expect(mark.status).toBe('active');
  });

  it('accept-gradually puts the mark into a transitioning state', async () => {
    const { store, client, storyId, storylineId } = await setup();
    const report = await checkDrift(store, client, storylineId);
    const finding = report.findings[0];

    resolveDrift(store, storylineId, report.id, finding.id, 'accept-gradually', 'ease it in');

    const canon = currentCanonVersion(store.getCanonRegistry(storyId))!;
    const mark = canon.entities.find((e) => e.id === 'CHAR_BOBO_001')!.marks.find((m) => m.key === 'scarf')!;
    expect(mark.status).toBe('transitioning');
    expect(mark.transition).toMatchObject({
      from: 'bright green leaf scarf',
      to: 'red woolly scarf',
    });

    // Future storylines see the blending instruction.
    const { buildCanonBlock } = await import('../src/services/canon');
    expect(buildCanonBlock(canon)).toContain('blend toward the new value');
  });

  it('reject records the resolution without touching canon', async () => {
    const { store, client, storyId, storylineId } = await setup();
    const report = await checkDrift(store, client, storylineId);
    const finding = report.findings[0];

    const result = resolveDrift(store, storylineId, report.id, finding.id, 'reject', 'stay on canon');
    expect(result.finding.resolution?.action).toBe('reject');
    expect(result.finding.resolution?.canonVersion).toBeNull();
    expect(store.getCanonRegistry(storyId)!.currentVersion).toBe(1);
  });

  it('refuses to resolve a finding twice', async () => {
    const { store, client, storylineId } = await setup();
    const report = await checkDrift(store, client, storylineId);
    const finding = report.findings[0];
    resolveDrift(store, storylineId, report.id, finding.id, 'reject');
    expect(() => resolveDrift(store, storylineId, report.id, finding.id, 'accept-now')).toThrow(/already resolved/);
  });

  it('accepting drift on an untracked mark adds it to canon first', async () => {
    const custom = JSON.stringify({
      summary: 'New fact appeared.',
      findings: [
        {
          entity_name: 'Bobo',
          mark_key: 'hat',
          expected: '',
          observed: 'tiny straw hat',
          scene_numbers: [1],
          severity: 'medium',
          explanation: 'Bobo suddenly wears a hat; canon has no hat mark.',
          suggestion: 'Decide whether the hat becomes canonical.',
        },
      ],
    });
    const { store, client, storyId, storylineId } = await setup(custom);
    const report = await checkDrift(store, client, storylineId);

    resolveDrift(store, storylineId, report.id, report.findings[0].id, 'accept-now');
    const canon = currentCanonVersion(store.getCanonRegistry(storyId))!;
    const hat = canon.entities.find((e) => e.id === 'CHAR_BOBO_001')!.marks.find((m) => m.key === 'hat')!;
    expect(hat.value).toBe('tiny straw hat');
  });
});
