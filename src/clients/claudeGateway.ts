import type { AnthropicLike, AnthropicResponse } from './claude';

/**
 * Adapter that fulfils the {@link AnthropicLike} contract used by
 * {@link generateStoryline} without ever touching the Anthropic API directly.
 *
 * Instead it drives the local **Claude Code Gateway** (an HTTP wrapper around
 * the `claude --print` CLI, default http://localhost:8757). The gateway uses
 * whatever auth the CLI is signed in with (claude.ai subscription or an API
 * key configured on the gateway itself), so this app needs no API key.
 *
 * The gateway's `POST /api/v1/claude/prompt` endpoint covers everything the
 * storyline generator needs: a system prompt, a user prompt, structured output
 * via a JSON schema, a reasoning `effort`, and a fallback model. We translate
 * the Anthropic-style `messages.create` params into that request and map the
 * gateway's response back into an {@link AnthropicResponse}.
 */
export interface GatewayClientOptions {
  /** Gateway base URL, e.g. `http://localhost:8757` (no trailing slash needed). */
  baseUrl: string;
  /** Per-request timeout handed to the CLI. Defaults to 300s. */
  timeoutSeconds?: number;
  /** Injectable fetch for testing; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Subset of the gateway's `ClaudeRequest` schema that we populate. */
interface GatewayRequest {
  prompt: string;
  model?: string;
  fallbackModel?: string;
  systemPrompt?: string;
  outputFormat?: 'text' | 'json' | 'stream-json';
  jsonSchema?: string;
  effort?: string;
  timeoutSeconds?: number;
}

/** Subset of the gateway's `ClaudeResponse` schema that we read. */
interface GatewayResponse {
  success?: boolean;
  isError?: boolean;
  subtype?: string;
  result?: string;
  stopReason?: string;
  exitCode?: number;
}

interface AnthropicParams {
  model?: string;
  system?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
  output_config?: {
    format?: { type?: string; schema?: unknown };
    effort?: string;
  };
  fallbacks?: Array<{ model?: string }>;
  [key: string]: unknown;
}

/** Flatten an Anthropic message `content` (string or content-block array) to text. */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === 'object' && 'text' in block
          ? String((block as { text?: unknown }).text ?? '')
          : '',
      )
      .join('');
  }
  return '';
}

function toGatewayRequest(params: AnthropicParams, timeoutSeconds: number): GatewayRequest {
  const prompt = (params.messages ?? [])
    .filter((m) => (m.role ?? 'user') === 'user')
    .map((m) => contentToText(m.content))
    .join('\n\n');

  const outputConfig = params.output_config;
  const schema = outputConfig?.format?.schema;

  const req: GatewayRequest = { prompt, timeoutSeconds };
  if (params.model) req.model = params.model;
  if (params.system) req.systemPrompt = params.system;
  if (schema !== undefined) {
    req.outputFormat = 'json';
    req.jsonSchema = JSON.stringify(schema);
  }
  if (outputConfig?.effort) req.effort = outputConfig.effort;
  // The Anthropic beta `fallbacks` array maps onto the CLI's single fallback model.
  const fallback = params.fallbacks?.[0]?.model;
  if (fallback) req.fallbackModel = fallback;
  return req;
}

function toAnthropicResponse(gw: GatewayResponse): AnthropicResponse {
  const refused = gw.stopReason === 'refusal';
  // Surface genuine execution failures loudly; let refusals flow through so the
  // caller's refusal handling (ClaudeError 'refusal') can report them.
  if (!refused && !gw.result) {
    const detail = gw.subtype ?? (gw.isError ? 'error' : 'no result');
    throw new Error(`Claude gateway returned no result (subtype: ${detail}, exit: ${gw.exitCode ?? '?'}).`);
  }
  return {
    stop_reason: gw.stopReason,
    content: gw.result ? [{ type: 'text', text: gw.result }] : [],
  };
}

/** Turn a raw fetch failure into a message that tells the user what to actually check. */
function describeNetworkError(err: unknown, baseUrl: string): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
  const code = cause && typeof cause === 'object' && 'code' in cause ? String((cause as { code?: unknown }).code) : '';
  if (err instanceof DOMException && err.name === 'AbortError') {
    return `The request to the Claude Code Gateway (${baseUrl}) was cancelled or timed out before it finished.`;
  }
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(message)) {
    return `Could not reach the Claude Code Gateway at ${baseUrl} — is it running?`;
  }
  if (code === 'ENOTFOUND' || /ENOTFOUND/.test(message)) {
    return `Could not resolve the Claude Code Gateway host (${baseUrl}). Check the CLAUDE_GATEWAY_URL setting.`;
  }
  if (/timed? ?out|ETIMEDOUT/i.test(message)) {
    return `Timed out waiting for the Claude Code Gateway at ${baseUrl} to respond.`;
  }
  return `Could not reach the Claude Code Gateway at ${baseUrl}: ${message}`;
}

/** Build a client that satisfies {@link AnthropicLike} but is backed by the gateway. */
export function createGatewayClaudeClient(options: GatewayClientOptions): AnthropicLike {
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const timeoutSeconds = options.timeoutSeconds ?? 300;
  const doFetch = options.fetchImpl ?? fetch;

  async function run(params: Record<string, unknown>): Promise<AnthropicResponse> {
    const body = toGatewayRequest(params as AnthropicParams, timeoutSeconds);
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}/api/v1/claude/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(describeNetworkError(err, baseUrl));
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Claude gateway request failed (HTTP ${res.status}): ${text.slice(0, 500)}`);
    }
    const gw = (await res.json()) as GatewayResponse;
    return toAnthropicResponse(gw);
  }

  return {
    messages: { create: run },
    // The beta surface takes the same params (plus `betas`/`fallbacks`) and,
    // through the gateway, resolves to the very same CLI call.
    beta: { messages: { create: run } },
  };
}

// Exposed for unit tests.
export const _internal = { toGatewayRequest, toAnthropicResponse, contentToText, describeNetworkError };
