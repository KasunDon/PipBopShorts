import { describe, expect, it } from 'vitest';
import { costFromEvent } from '../src/costs/costFromEvent';
import {
  CLAUDE_PRICING,
  createPixverseProvider,
  formatUsd,
  normalizeModelId,
  priceLlmFromTokens,
} from '../src/costs/pricing';
import { buildCostReport } from '../src/costs/report';
import type { AuditEvent } from '../src/events/eventStore';

function event(partial: Partial<AuditEvent>): AuditEvent {
  return {
    id: partial.id ?? 'evt_1',
    ts: partial.ts ?? '2026-07-03T00:00:00.000Z',
    durationMs: 10,
    service: partial.service ?? 'claude',
    type: 'x',
    method: 'POST',
    url: partial.url ?? 'http://localhost:8757/api/v1/claude/prompt',
    status: partial.status ?? 'ok',
    summary: '',
    request: partial.request,
    response: partial.response,
    context: partial.context,
    ...partial,
  };
}

describe('LLM pricing', () => {
  it('prices Opus 4.8 from tokens at $5/$25 per million', () => {
    const cost = priceLlmFromTokens('claude-opus-4-8', { inputTokens: 1_000_000, outputTokens: 1_000_000 })!;
    expect(cost.usd).toBeCloseTo(30, 5); // 5 + 25
    expect(cost.provider).toBe('claude');
    expect(cost.kind).toBe('llm');
  });

  it('adds cache read/write at 0.1x / 1.25x input by default', () => {
    const cost = priceLlmFromTokens('claude-haiku-4-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    })!;
    // haiku input $1/M → cacheRead $0.1/M, cacheWrite $1.25/M
    expect(cost.usd).toBeCloseTo(0.1 + 1.25, 5);
  });

  it('normalizes dated model ids and returns null for unknown models', () => {
    expect(normalizeModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(priceLlmFromTokens('gpt-5', { inputTokens: 100 })).toBeNull();
    expect(Object.keys(CLAUDE_PRICING)).toContain('claude-sonnet-5');
  });
});

describe('PixVerse pricing', () => {
  it('prices a video render from quality + duration', () => {
    const provider = createPixverseProvider(0.01);
    const cost = provider.price({ kind: 'video', quality: '720p', durationSec: 5 });
    expect(cost.credits).toBe(60);
    expect(cost.usd).toBeCloseTo(0.6, 5);
    expect(cost.provider).toBe('pixverse');
  });

  it('is configurable by credit→USD rate', () => {
    expect(createPixverseProvider(0.02).price({ kind: 'video', quality: '540p', durationSec: 5 }).usd).toBeCloseTo(0.6, 5);
  });
});

describe('costFromEvent', () => {
  it('prefers the gateway-reported exact cost for LLM calls', () => {
    const cost = costFromEvent(
      event({
        service: 'claude',
        request: { body: { model: 'claude-haiku-4-5' } },
        response: { totalCostUsd: 0.0234, usage: { input_tokens: 10, output_tokens: 20 } },
      }),
    )!;
    expect(cost.usd).toBe(0.0234);
    expect(cost.exact).toBe(true);
    expect(cost.tokens?.outputTokens).toBe(20);
  });

  it('falls back to token pricing when the gateway reports no cost', () => {
    const cost = costFromEvent(
      event({
        service: 'claude',
        request: { body: { model: 'claude-opus-4-8' } },
        response: { usage: { input_tokens: 1_000_000, output_tokens: 0 } },
      }),
    )!;
    expect(cost.usd).toBeCloseTo(5, 5);
    expect(cost.exact).toBe(false);
  });

  it('prices a PixVerse video generation from the request body', () => {
    const cost = costFromEvent(
      event({
        service: 'pixverse',
        url: 'https://app-api.pixverse.ai/openapi/v2/video/text/generate',
        request: { body: { model: 'v5', quality: '540p', duration: 5 } },
        response: { ErrCode: 0, Resp: { video_id: 1 } },
      }),
    )!;
    expect(cost.kind).toBe('video');
    expect(cost.credits).toBe(30);
  });

  it('does not bill polling or failed calls', () => {
    expect(
      costFromEvent(event({ service: 'pixverse', url: 'https://x/openapi/v2/video/result/1', response: { ErrCode: 0 } })),
    ).toBeNull();
    expect(costFromEvent(event({ status: 'error', response: { totalCostUsd: 1 } }))).toBeNull();
  });
});

describe('cost report', () => {
  it('aggregates totals by provider, kind, model, phase, and story', () => {
    const events: AuditEvent[] = [
      event({
        id: 'a',
        service: 'claude',
        context: { storyId: 's1', phase: 'storyline' },
        cost: { usd: 0.1, credits: null, kind: 'llm', provider: 'claude', model: 'claude-opus-4-8', exact: true, breakdown: [], tokens: { inputTokens: 100, outputTokens: 50 } },
      }),
      event({
        id: 'b',
        service: 'pixverse',
        context: { storyId: 's1', phase: 'clip' },
        cost: { usd: 0.6, credits: 60, kind: 'video', provider: 'pixverse', exact: false, breakdown: [] },
      }),
      event({ id: 'c', service: 'youtube', context: { storyId: 's2' }, cost: null }),
    ];
    const report = buildCostReport(events);
    expect(report.totalUsd).toBeCloseTo(0.7, 5);
    expect(report.totalCredits).toBe(60);
    expect(report.billableCount).toBe(2);
    expect(report.byProvider.claude.usd).toBeCloseTo(0.1, 5);
    expect(report.byProvider.pixverse.credits).toBe(60);
    expect(report.byKind.video.usd).toBeCloseTo(0.6, 5);
    expect(report.byPhase.storyline.usd).toBeCloseTo(0.1, 5);
    expect(report.tokens.inputTokens).toBe(100);
    expect(report.byStory[0].id).toBe('s1');
    expect(report.hasEstimates).toBe(true);
  });

  it('filters by storyId and since', () => {
    const events: AuditEvent[] = [
      event({ id: 'a', ts: '2026-07-01T00:00:00Z', context: { storyId: 's1' }, cost: { usd: 1, credits: null, kind: 'llm', provider: 'claude', exact: true, breakdown: [] } }),
      event({ id: 'b', ts: '2026-07-05T00:00:00Z', context: { storyId: 's2' }, cost: { usd: 2, credits: null, kind: 'llm', provider: 'claude', exact: true, breakdown: [] } }),
    ];
    expect(buildCostReport(events, { storyId: 's2' }).totalUsd).toBe(2);
    expect(buildCostReport(events, { since: '2026-07-03T00:00:00Z' }).totalUsd).toBe(2);
  });
});

describe('formatUsd', () => {
  it('shows sub-cent precision for tiny amounts', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.0023)).toBe('$0.0023');
    expect(formatUsd(1.5)).toBe('$1.50');
  });
});
