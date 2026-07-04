import type { EventService, EventStore } from './eventStore';

type FetchLike = typeof fetch;

const MAX_TEXT_LEN = 200_000;
const SECRET_KEY_PATTERN = /api.?key|authorization|secret|token|password|refresh_token|access_token/i;
const TEXTUAL_CONTENT_TYPE = /json|text|xml|urlencoded/i;

/** Deep-redact any object key that looks like a credential. */
function deepRedact(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => deepRedact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? '[redacted]' : deepRedact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function truncateText(text: string): { value: string; truncated: boolean } {
  if (text.length <= MAX_TEXT_LEN) return { value: text, truncated: false };
  return { value: `${text.slice(0, MAX_TEXT_LEN)}\n…[truncated ${text.length - MAX_TEXT_LEN} more chars]`, truncated: true };
}

function normalizeHeaders(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = init?.headers;
  if (!raw) return out;
  let entries: Array<[string, string]>;
  if (raw instanceof Headers) {
    entries = [...raw.entries()];
  } else if (Array.isArray(raw)) {
    entries = raw.map(([k, v]) => [String(k), String(v)]);
  } else {
    entries = Object.entries(raw as Record<string, string>);
  }
  for (const [key, value] of entries) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? '[redacted]' : value;
  }
  return out;
}

/** Best-effort description of an outbound request body without ever buffering raw bytes. */
function describeRequestBody(body: RequestInit['body'] | null | undefined): unknown {
  if (body === null || body === undefined) return undefined;
  if (typeof body === 'string') {
    try {
      return deepRedact(JSON.parse(body));
    } catch {
      return truncateText(body).value;
    }
  }
  if (body instanceof URLSearchParams) {
    return deepRedact(Object.fromEntries(body.entries()));
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of body.entries()) {
      if (typeof v === 'string') {
        out[key] = SECRET_KEY_PATTERN.test(key) ? '[redacted]' : v;
      } else {
        const blob = v as File | Blob;
        out[key] = `[file ${'name' in blob ? blob.name : 'blob'}, ${blob.size} bytes, ${blob.type || 'unknown type'}]`;
      }
    }
    return { formData: out };
  }
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    const byteLength = body instanceof ArrayBuffer ? body.byteLength : body.byteLength;
    return `[binary body, ${byteLength} bytes]`;
  }
  return '[unrecognized body]';
}

/** Read a response for logging without disturbing the original stream the caller consumes. */
async function describeResponseBody(res: Response): Promise<unknown> {
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType && !TEXTUAL_CONTENT_TYPE.test(contentType)) {
    const len = res.headers.get('content-length');
    return `[binary response, content-type: ${contentType}${len ? `, ${len} bytes` : ''}]`;
  }
  try {
    const text = await res.clone().text();
    if (!text) return undefined;
    try {
      return deepRedact(JSON.parse(text));
    } catch {
      return truncateText(text).value;
    }
  } catch (err) {
    return `[failed to read response body: ${(err as Error).message}]`;
  }
}

function urlPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Infer a short dotted event type from the URL path, e.g. "pixverse.video.result". */
function inferType(service: EventService, method: string, pathname: string): string {
  const segments = pathname
    .split('/')
    .filter(Boolean)
    .filter((s) => !['api', 'openapi', 'v1', 'v2', 'v3', 'upload', 'youtube', service].includes(s))
    .map((s) => (/^\d+$/.test(s) ? ':id' : s))
    .slice(-4);
  const suffix = segments.join('.') || method.toLowerCase();
  return `${service}.${suffix}`;
}

/** Pull a human-readable one-liner out of whatever the request/response happened to contain. */
function buildSummary(method: string, pathname: string, reqBody: unknown, resBody: unknown, errorMessage?: string): string {
  if (errorMessage) return `${method} ${pathname} — ${errorMessage}`;
  const req = reqBody as Record<string, unknown> | undefined;
  const res = resBody as Record<string, unknown> | undefined;
  const resp = (res?.Resp ?? res) as Record<string, unknown> | undefined;

  if (typeof req?.prompt === 'string' && req.prompt) {
    return `prompt: ${excerpt(req.prompt)}`;
  }
  if (typeof req?.snippet === 'object' && req.snippet && typeof (req.snippet as Record<string, unknown>).title === 'string') {
    return `upload: ${(req.snippet as Record<string, unknown>).title}`;
  }
  if (res?.ErrMsg !== undefined) {
    const status = resp?.status !== undefined ? ` status=${resp.status}` : '';
    const videoId = resp?.video_id !== undefined ? ` video_id=${resp.video_id}` : '';
    return `${res.ErrMsg}${status}${videoId}`;
  }
  if (typeof res?.result === 'string' && res.result) {
    return `result: ${excerpt(res.result)}`;
  }
  return `${method} ${pathname}`;
}

function excerpt(text: string, max = 110): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * Wrap a fetch implementation so every call is captured to the event store as
 * an {@link AuditEvent} — request, response, timing, redacted secrets — while
 * returning the original, untouched Response to the caller.
 */
export function instrumentFetch(fetchImpl: FetchLike, store: EventStore, service: EventService): FetchLike {
  const wrapped: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : undefined) ?? 'GET').toUpperCase();
    const pathname = urlPathname(url);
    const started = Date.now();
    const requestSummary = { headers: normalizeHeaders(init), body: describeRequestBody(init?.body ?? null) };

    let response: Response;
    try {
      response = await fetchImpl(input, init);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.record({
        durationMs: Date.now() - started,
        service,
        type: inferType(service, method, pathname),
        method,
        url,
        status: 'error',
        summary: buildSummary(method, pathname, requestSummary.body, undefined, message),
        request: requestSummary,
        response: undefined,
        error: message,
      });
      throw err;
    }

    const responseBody = await describeResponseBody(response);
    const pixverseError =
      service === 'pixverse' &&
      responseBody &&
      typeof responseBody === 'object' &&
      Number((responseBody as Record<string, unknown>).ErrCode) !== 0;
    const status: 'ok' | 'error' = response.ok && !pixverseError ? 'ok' : 'error';

    store.record({
      durationMs: Date.now() - started,
      service,
      type: inferType(service, method, pathname),
      method,
      url,
      status,
      httpStatus: response.status,
      summary: buildSummary(method, pathname, requestSummary.body, responseBody),
      request: requestSummary,
      response: responseBody,
      error: status === 'error' ? `HTTP ${response.status}` : undefined,
    });

    return response;
  };
  return wrapped;
}
