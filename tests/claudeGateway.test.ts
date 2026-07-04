import { describe, expect, it } from 'vitest';
import { createGatewayClaudeClient, _internal } from '../src/clients/claudeGateway';
import { generateStoryline } from '../src/clients/claude';
import { sampleStorylineJson } from './helpers';

const { toGatewayRequest, toAnthropicResponse, contentToText, describeNetworkError } = _internal;

describe('gateway request mapping', () => {
  it('translates system, user prompt, schema and effort into a gateway request', () => {
    const req = toGatewayRequest(
      {
        model: 'claude-opus-4-8',
        system: 'You are a director.',
        messages: [{ role: 'user', content: 'Write a storyline.' }],
        output_config: { format: { type: 'json_schema', schema: { type: 'object' } }, effort: 'high' },
      },
      300,
    );
    expect(req.model).toBe('claude-opus-4-8');
    expect(req.systemPrompt).toBe('You are a director.');
    expect(req.prompt).toBe('Write a storyline.');
    expect(req.outputFormat).toBe('json');
    expect(req.jsonSchema).toBe(JSON.stringify({ type: 'object' }));
    expect(req.effort).toBe('high');
    expect(req.timeoutSeconds).toBe(300);
  });

  it('maps the beta fallbacks array onto a single fallbackModel', () => {
    const req = toGatewayRequest(
      { model: 'claude-fable-5', messages: [{ role: 'user', content: 'go' }], fallbacks: [{ model: 'claude-opus-4-8' }] },
      120,
    );
    expect(req.fallbackModel).toBe('claude-opus-4-8');
  });

  it('flattens content-block arrays to text', () => {
    expect(contentToText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('ab');
    expect(contentToText('plain')).toBe('plain');
  });
});

describe('gateway response mapping', () => {
  it('wraps a successful result as a text content block', () => {
    const res = toAnthropicResponse({ success: true, result: '{"ok":true}', stopReason: 'tool_use' });
    expect(res.stop_reason).toBe('tool_use');
    expect(res.content).toEqual([{ type: 'text', text: '{"ok":true}' }]);
  });

  it('passes a refusal through so the caller can handle it', () => {
    const res = toAnthropicResponse({ success: false, stopReason: 'refusal', result: '' });
    expect(res.stop_reason).toBe('refusal');
    expect(res.content).toEqual([]);
  });

  it('throws on an execution failure with no result', () => {
    expect(() => toAnthropicResponse({ success: false, isError: true, subtype: 'error_during_execution', exitCode: 1 })).toThrow(
      /Claude gateway returned no result/,
    );
  });
});

describe('network error messages', () => {
  it('flags a connection-refused error clearly, mentioning the gateway URL', () => {
    const err = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    expect(describeNetworkError(err, 'http://localhost:8757')).toMatch(/Could not reach.*http:\/\/localhost:8757.*running\?/);
  });

  it('flags a DNS failure distinctly', () => {
    const err = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    expect(describeNetworkError(err, 'http://bad-host:8757')).toMatch(/Could not resolve.*CLAUDE_GATEWAY_URL/);
  });

  it('flags an abort/timeout distinctly', () => {
    const err = new DOMException('The operation was aborted.', 'AbortError');
    expect(describeNetworkError(err, 'http://localhost:8757')).toMatch(/cancelled or timed out/);
  });

  it('falls back to a generic reachable-gateway message for anything else', () => {
    expect(describeNetworkError(new Error('boom'), 'http://localhost:8757')).toMatch(/Could not reach.*boom/);
  });

  it('surfaces the friendly message through the gateway client when fetch throws', async () => {
    const fakeFetch = (async () => {
      throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }) as unknown as typeof fetch;
    const client = createGatewayClaudeClient({ baseUrl: 'http://localhost:8757', fetchImpl: fakeFetch });
    await expect(client.messages.create({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      /Could not reach the Claude Code Gateway.*running\?/,
    );
  });
});

describe('gateway client end-to-end (fake fetch)', () => {
  it('drives generateStoryline through /api/v1/claude/prompt', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return {
        ok: true,
        json: async () => ({ success: true, result: sampleStorylineJson(2), stopReason: 'tool_use' }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const client = createGatewayClaudeClient({ baseUrl: 'http://localhost:8757/', fetchImpl: fakeFetch });
    const result = await generateStoryline(client, {
      bible: '# Bible\nHero: a cat astronaut.',
      episodeTitle: 'Episode 1',
      episodeBrief: 'The cat launches into space.',
      model: 'claude-opus-4-8',
      effort: 'high',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://localhost:8757/api/v1/claude/prompt');
    expect(calls[0].body.systemPrompt).toContain('PixVerse');
    expect(calls[0].body.prompt).toContain('cat astronaut');
    expect(calls[0].body.effort).toBe('high');
    expect(calls[0].body.outputFormat).toBe('json');
    expect(result.scenes).toHaveLength(2);
    expect(result.model).toBe('claude-opus-4-8');
  });
});
