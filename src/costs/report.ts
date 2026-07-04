import type { AuditEvent } from '../events/eventStore';

export interface CostBucket {
  usd: number;
  credits: number;
  count: number;
}

export interface ModelBucket extends CostBucket {
  inputTokens: number;
  outputTokens: number;
}

export interface ScopeBucket extends CostBucket {
  id: string;
}

export interface CostReport {
  generatedAt: string;
  totalUsd: number;
  totalCredits: number;
  /** Total captured events considered (after filtering). */
  eventCount: number;
  /** Events that carried a billable cost. */
  billableCount: number;
  tokens: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  byProvider: Record<string, CostBucket>;
  byKind: Record<string, CostBucket>;
  byModel: Record<string, ModelBucket>;
  byPhase: Record<string, CostBucket>;
  byStory: ScopeBucket[];
  byEpisode: ScopeBucket[];
  /** Whether any figure in the report is an estimate (vs. an exact reported cost). */
  hasEstimates: boolean;
}

export interface CostReportFilter {
  storyId?: string;
  episodeId?: string;
  /** ISO timestamp; only events at or after this are counted. */
  since?: string;
}

function emptyBucket(): CostBucket {
  return { usd: 0, credits: 0, count: 0 };
}

function add(map: Record<string, CostBucket>, key: string, usd: number, credits: number): void {
  const b = (map[key] ??= emptyBucket());
  b.usd += usd;
  b.credits += credits;
  b.count += 1;
}

/** Aggregate captured events into a cost report, optionally scoped to a story/episode/time window. */
export function buildCostReport(events: AuditEvent[], filter: CostReportFilter = {}): CostReport {
  const report: CostReport = {
    generatedAt: new Date().toISOString(),
    totalUsd: 0,
    totalCredits: 0,
    eventCount: 0,
    billableCount: 0,
    tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    byProvider: {},
    byKind: {},
    byModel: {},
    byPhase: {},
    byStory: [],
    byEpisode: [],
    hasEstimates: false,
  };
  const stories: Record<string, ScopeBucket> = {};
  const episodes: Record<string, ScopeBucket> = {};

  for (const event of events) {
    if (filter.since && event.ts < filter.since) continue;
    const ctx = event.context ?? {};
    if (filter.storyId && ctx.storyId !== filter.storyId) continue;
    if (filter.episodeId && ctx.episodeId !== filter.episodeId) continue;
    report.eventCount += 1;

    const cost = event.cost;
    if (!cost) continue;
    report.billableCount += 1;

    const usd = cost.usd || 0;
    const credits = cost.credits || 0;
    report.totalUsd += usd;
    report.totalCredits += credits;
    if (!cost.exact) report.hasEstimates = true;

    add(report.byProvider, cost.provider, usd, credits);
    add(report.byKind, cost.kind, usd, credits);
    add(report.byPhase, ctx.phase || 'other', usd, credits);

    const modelKey = cost.model ?? cost.provider;
    const mb = (report.byModel[modelKey] ??= { usd: 0, credits: 0, count: 0, inputTokens: 0, outputTokens: 0 });
    mb.usd += usd;
    mb.credits += credits;
    mb.count += 1;
    if (cost.tokens) {
      mb.inputTokens += cost.tokens.inputTokens ?? 0;
      mb.outputTokens += cost.tokens.outputTokens ?? 0;
      report.tokens.inputTokens += cost.tokens.inputTokens ?? 0;
      report.tokens.outputTokens += cost.tokens.outputTokens ?? 0;
      report.tokens.cacheReadTokens += cost.tokens.cacheReadTokens ?? 0;
      report.tokens.cacheWriteTokens += cost.tokens.cacheWriteTokens ?? 0;
    }

    if (ctx.storyId) {
      const s = (stories[ctx.storyId] ??= { id: ctx.storyId, usd: 0, credits: 0, count: 0 });
      s.usd += usd;
      s.credits += credits;
      s.count += 1;
    }
    if (ctx.episodeId) {
      const e = (episodes[ctx.episodeId] ??= { id: ctx.episodeId, usd: 0, credits: 0, count: 0 });
      e.usd += usd;
      e.credits += credits;
      e.count += 1;
    }
  }

  report.byStory = Object.values(stories).sort((a, b) => b.usd - a.usd);
  report.byEpisode = Object.values(episodes).sort((a, b) => b.usd - a.usd);
  return report;
}
