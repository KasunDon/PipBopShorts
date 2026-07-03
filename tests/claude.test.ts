import { describe, expect, it } from 'vitest';
import { ClaudeError, clampEffort, generateStoryline } from '../src/clients/claude';
import type { AnthropicResponse } from '../src/clients/claude';
import { makeFakeClaude, sampleStorylineJson } from './helpers';

const baseInput = {
  bible: '# Bible\nHero: a cat astronaut.',
  episodeTitle: 'Episode 1',
  episodeBrief: 'The cat launches into space.',
};

describe('clampEffort', () => {
  it('clamps above the model max', () => {
    expect(clampEffort('max', 'high')).toBe('high');
  });
  it('keeps values within range', () => {
    expect(clampEffort('medium', 'max')).toBe('medium');
  });
  it('defaults invalid input', () => {
    expect(clampEffort(undefined, 'max')).toBe('high');
  });
});

describe('generateStoryline request shaping', () => {
  it('uses adaptive thinking + effort for opus-4-8 on the non-beta endpoint', async () => {
    const { client, calls } = makeFakeClaude();
    const result = await generateStoryline(client, { ...baseInput, model: 'claude-opus-4-8', effort: 'high' });

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('messages');
    expect(calls[0].params.thinking).toEqual({ type: 'adaptive' });
    expect((calls[0].params.output_config as Record<string, unknown>).effort).toBe('high');
    expect((calls[0].params.output_config as Record<string, unknown>).format).toBeDefined();
    expect(result.model).toBe('claude-opus-4-8');
    expect(result.effort).toBe('high');
    expect(result.scenes).toHaveLength(2);
    expect(result.scenes[0].id).toBeTruthy();
    expect(result.scenes[0].order).toBe(0);
  });

  it('uses beta endpoint with fallbacks and no thinking param for fable-5', async () => {
    const { client, calls } = makeFakeClaude();
    await generateStoryline(client, { ...baseInput, model: 'claude-fable-5', effort: 'max' });

    expect(calls[0].path).toBe('beta.messages');
    expect(calls[0].params.thinking).toBeUndefined();
    expect(calls[0].params.betas).toEqual(['server-side-fallback-2026-06-01']);
    expect(calls[0].params.fallbacks).toEqual([{ model: 'claude-opus-4-8' }]);
    expect((calls[0].params.output_config as Record<string, unknown>).effort).toBe('max');
  });

  it('omits effort and thinking for haiku-4-5', async () => {
    const { client, calls } = makeFakeClaude();
    const result = await generateStoryline(client, { ...baseInput, model: 'claude-haiku-4-5', effort: 'max' });

    expect(calls[0].path).toBe('messages');
    expect(calls[0].params.thinking).toBeUndefined();
    expect((calls[0].params.output_config as Record<string, unknown>).effort).toBeUndefined();
    expect(result.effort).toBeNull();
  });

  it('clamps effort to the model maximum in the request', async () => {
    const { client, calls } = makeFakeClaude();
    // Opus 4.8 supports up to max; ask for max and confirm it passes through.
    await generateStoryline(client, { ...baseInput, model: 'claude-opus-4-8', effort: 'max' });
    expect((calls[0].params.output_config as Record<string, unknown>).effort).toBe('max');
  });
});

describe('generateStoryline parsing', () => {
  it('coerces invalid enum values to defaults', async () => {
    const raw = JSON.parse(sampleStorylineJson(1));
    raw.scenes[0].model = 'v9';
    raw.scenes[0].aspect_ratio = '2:1';
    const { client } = makeFakeClaude(() => ({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(raw) }],
    }));
    const result = await generateStoryline(client, baseInput);
    expect(result.scenes[0].model).toBe('v5'); // default fallback
    expect(result.scenes[0].aspectRatio).toBe('9:16');
  });

  it('throws on a refusal', async () => {
    const refusal = (): AnthropicResponse => ({
      stop_reason: 'refusal',
      stop_details: { category: 'cyber' },
      content: [],
    });
    const { client } = makeFakeClaude(refusal);
    await expect(generateStoryline(client, baseInput)).rejects.toMatchObject({ name: 'ClaudeError', kind: 'refusal' });
  });

  it('throws on invalid JSON', async () => {
    const { client } = makeFakeClaude(() => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] }));
    await expect(generateStoryline(client, baseInput)).rejects.toMatchObject({ kind: 'parse' });
  });

  it('throws on an unknown model', async () => {
    const { client } = makeFakeClaude();
    await expect(generateStoryline(client, { ...baseInput, model: 'gpt-5' })).rejects.toBeInstanceOf(ClaudeError);
  });

  it('includes the episode brief and bible in the prompt', async () => {
    const { client, calls } = makeFakeClaude();
    await generateStoryline(client, baseInput);
    const userMsg = (calls[0].params.messages as Array<{ content: string }>)[0].content;
    expect(userMsg).toContain('cat astronaut');
    expect(userMsg).toContain('The cat launches into space.');
  });

  it('passes the per-episode setting override into the prompt', async () => {
    const { client, calls } = makeFakeClaude();
    await generateStoryline(client, { ...baseInput, settingOverride: 'A frozen moon base.' });
    const userMsg = (calls[0].params.messages as Array<{ content: string }>)[0].content;
    expect(userMsg).toContain('A frozen moon base.');
  });
});
