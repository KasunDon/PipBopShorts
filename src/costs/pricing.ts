/**
 * Provider-agnostic cost/pricing framework.
 *
 * Every paid operation in the studio — an LLM call, a PixVerse video render, an
 * image upload — is priced through this module into a normalized {@link CostEstimate}
 * (USD, and provider credits where they apply). New providers (Runway, Kling,
 * Luma, …) are added by registering a {@link MediaProvider}; nothing else in the
 * app needs to know provider-specific pricing.
 *
 * Numbers here are editable in one place. LLM rates are real (Anthropic list
 * pricing). PixVerse credit costs are **configurable estimates** — PixVerse
 * bills in credits and exact per-render credit costs vary by plan, so tune
 * {@link PIXVERSE_CREDIT_TABLE} / the credit→USD rate to match your account.
 */

export type CostKind = 'llm' | 'video' | 'image' | 'other';

export interface CostEstimate {
  usd: number;
  /** Provider credits consumed, when the provider bills in credits (PixVerse). */
  credits: number | null;
  kind: CostKind;
  provider: string;
  /** Model/tier the cost was computed for, when known. */
  model?: string;
  /** Whether this figure is a reported exact cost (true) or a table estimate (false). */
  exact: boolean;
  /** Token usage for LLM calls (captured for analytics). */
  tokens?: TokenUsage;
  /** Human-readable line items for transparency in the UI. */
  breakdown: string[];
}

// ---------------------------------------------------------------------------
// LLM pricing (Anthropic list prices, USD per 1M tokens)
// ---------------------------------------------------------------------------

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface LlmModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Defaults to 0.1× input (cache read) and 1.25× input (5-minute cache write). */
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
}

/** Anthropic list pricing (USD / 1M tokens). Cache read ≈ 0.1× input, write ≈ 1.25× input. */
export const CLAUDE_PRICING: Record<string, LlmModelPricing> = {
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50 },
};

/** Normalize a model id to a pricing key (strips date suffixes like -20251001). */
export function normalizeModelId(model: string | undefined): string | undefined {
  if (!model) return undefined;
  if (CLAUDE_PRICING[model]) return model;
  // Try trimming a trailing -YYYYMMDD snapshot suffix.
  const trimmed = model.replace(/-\d{8}$/, '');
  return CLAUDE_PRICING[trimmed] ? trimmed : model;
}

/** Price an LLM call from token usage. Returns null when the model is unknown. */
export function priceLlmFromTokens(model: string | undefined, usage: TokenUsage): CostEstimate | null {
  const key = normalizeModelId(model);
  const p = key ? CLAUDE_PRICING[key] : undefined;
  if (!p) return null;
  const cacheRead = p.cacheReadPerMTok ?? p.inputPerMTok * 0.1;
  const cacheWrite = p.cacheWritePerMTok ?? p.inputPerMTok * 1.25;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cr = usage.cacheReadTokens ?? 0;
  const cw = usage.cacheWriteTokens ?? 0;
  const usd =
    (input / 1e6) * p.inputPerMTok +
    (output / 1e6) * p.outputPerMTok +
    (cr / 1e6) * cacheRead +
    (cw / 1e6) * cacheWrite;
  const breakdown = [
    `${input.toLocaleString()} input @ $${p.inputPerMTok}/M`,
    `${output.toLocaleString()} output @ $${p.outputPerMTok}/M`,
  ];
  if (cw) breakdown.push(`${cw.toLocaleString()} cache-write @ $${cacheWrite.toFixed(2)}/M`);
  if (cr) breakdown.push(`${cr.toLocaleString()} cache-read @ $${cacheRead.toFixed(2)}/M`);
  return { usd, credits: null, kind: 'llm', provider: 'claude', model: key, exact: false, tokens: usage, breakdown };
}

// ---------------------------------------------------------------------------
// Media provider pricing (video / image) — provider-agnostic registry
// ---------------------------------------------------------------------------

export interface MediaCostInput {
  kind: 'video' | 'image';
  model?: string;
  quality?: string;
  durationSec?: number;
  motionMode?: string;
}

export interface MediaProvider {
  name: string;
  /** USD per provider credit (configurable per account/plan). */
  creditUsd: number;
  price(input: MediaCostInput): CostEstimate;
}

/**
 * PixVerse credit costs per render — **estimates**, tune to your plan.
 * Keyed by quality, then duration (seconds). Motion/fast and higher models can
 * cost more; adjust here as your account's real rates become known.
 */
export const PIXVERSE_CREDIT_TABLE: Record<string, Record<number, number>> = {
  '360p': { 5: 20, 8: 30 },
  '540p': { 5: 30, 8: 45 },
  '720p': { 5: 60, 8: 90 },
  '1080p': { 5: 120, 8: 120 },
};

/** Credits for uploading a reference image (usually free/cheap). */
export const PIXVERSE_IMAGE_CREDITS = 0;

/** Default USD per PixVerse credit — configurable via PIXVERSE_CREDIT_USD. */
export const DEFAULT_PIXVERSE_CREDIT_USD = 0.012;

export function createPixverseProvider(creditUsd = DEFAULT_PIXVERSE_CREDIT_USD): MediaProvider {
  return {
    name: 'pixverse',
    creditUsd,
    price(input) {
      if (input.kind === 'image') {
        const credits = PIXVERSE_IMAGE_CREDITS;
        return {
          usd: credits * creditUsd,
          credits,
          kind: 'image',
          provider: 'pixverse',
          model: input.model,
          exact: false,
          breakdown: [`image upload: ${credits} credits`],
        };
      }
      const quality = input.quality ?? '540p';
      const duration = input.durationSec ?? 5;
      const byDuration = PIXVERSE_CREDIT_TABLE[quality];
      // Nearest known duration if an exact match is missing.
      const credits = byDuration?.[duration] ?? byDuration?.[5] ?? 30;
      const usd = credits * creditUsd;
      return {
        usd,
        credits,
        kind: 'video',
        provider: 'pixverse',
        model: input.model,
        exact: false,
        breakdown: [`${quality} ${duration}s${input.motionMode === 'fast' ? ' fast' : ''}: ${credits} credits @ $${creditUsd}/credit`],
      };
    },
  };
}

export function formatUsd(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
