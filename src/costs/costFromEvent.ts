import type { AuditEvent } from '../events/eventStore';
import { createPixverseProvider, priceLlmFromTokens, type CostEstimate, type MediaProvider, type TokenUsage } from './pricing';

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function requestBody(event: AuditEvent): Record<string, unknown> | undefined {
  const req = event.request as { body?: unknown } | undefined;
  return req && typeof req.body === 'object' && req.body ? (req.body as Record<string, unknown>) : undefined;
}

/** Cost of a Claude gateway call — prefer the gateway's reported total, fall back to token pricing. */
function llmCost(event: AuditEvent): CostEstimate | null {
  const res = event.response as Record<string, unknown> | undefined;
  if (!res || typeof res !== 'object') return null;
  const body = requestBody(event);
  const model = typeof body?.model === 'string' ? body.model : undefined;

  const usageRaw = res.usage as Record<string, unknown> | undefined;
  const tokens: TokenUsage = usageRaw
    ? {
        inputTokens: num(usageRaw.input_tokens),
        outputTokens: num(usageRaw.output_tokens),
        cacheReadTokens: num(usageRaw.cache_read_input_tokens),
        cacheWriteTokens: num(usageRaw.cache_creation_input_tokens),
      }
    : {};

  const estimate = priceLlmFromTokens(model, tokens);
  const reported = num(res.totalCostUsd);
  if (reported !== undefined && reported >= 0) {
    // The gateway reports the real billed cost — authoritative. Keep token
    // breakdown from the estimate for transparency.
    return {
      usd: reported,
      credits: null,
      kind: 'llm',
      provider: 'claude',
      model: estimate?.model ?? model,
      exact: true,
      tokens,
      breakdown: estimate?.breakdown ?? ['reported by Claude gateway'],
    };
  }
  return estimate;
}

/** Cost of a PixVerse call — video renders and image uploads cost; polling does not. */
function pixverseCost(event: AuditEvent, provider: MediaProvider): CostEstimate | null {
  const url = event.url;
  const body = requestBody(event);
  if (/\/image\/upload$/.test(url)) {
    return provider.price({ kind: 'image', model: typeof body?.model === 'string' ? body.model : undefined });
  }
  if (/\/video\/(text|img|extend)\/generate$/.test(url)) {
    return provider.price({
      kind: 'video',
      model: typeof body?.model === 'string' ? body.model : undefined,
      quality: typeof body?.quality === 'string' ? body.quality : undefined,
      durationSec: num(body?.duration),
      motionMode: typeof body?.motion_mode === 'string' ? body.motion_mode : undefined,
    });
  }
  return null; // result polling, etc. — no charge
}

export interface CostExtractorOptions {
  pixverse?: MediaProvider;
}

/**
 * Derive a normalized {@link CostEstimate} from a captured {@link AuditEvent},
 * or null when the call didn't incur a billable cost. Only successful calls are
 * priced — failed/refused calls that produced no output are treated as free.
 */
export function costFromEvent(event: AuditEvent, options: CostExtractorOptions = {}): CostEstimate | null {
  if (event.status !== 'ok') return null;
  if (event.service === 'claude') return llmCost(event);
  if (event.service === 'pixverse') return pixverseCost(event, options.pixverse ?? createPixverseProvider());
  // youtube uploads have no per-call media cost in this model
  return null;
}
