import { describe, expect, it } from 'vitest';
import { EventStore } from '../src/events/eventStore';
import { instrumentFetch } from '../src/events/instrument';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

describe('instrumentFetch', () => {
  it('captures a JSON request/response and still returns a usable response to the caller', async () => {
    const store = new EventStore();
    const fake: typeof fetch = async () => jsonResponse({ ErrCode: 0, ErrMsg: 'ok', Resp: { video_id: 42 } });
    const wrapped = instrumentFetch(fake, store, 'pixverse');

    const res = await wrapped('https://app-api.pixverse.ai/openapi/v2/video/text/generate', {
      method: 'POST',
      headers: { 'API-KEY': 'super-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'a cat astronaut', model: 'v5' }),
    });

    // The caller still gets a fully readable response.
    const json = (await res.json()) as { Resp: { video_id: number } };
    expect(json.Resp.video_id).toBe(42);

    const { events } = store.list();
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.service).toBe('pixverse');
    expect(event.method).toBe('POST');
    expect(event.status).toBe('ok');
    expect(event.httpStatus).toBe(200);
    expect(event.type).toBe('pixverse.video.text.generate');
    expect((event.request as { headers: Record<string, string> }).headers['API-KEY']).toBe('[redacted]');
    expect((event.request as { body: { prompt: string } }).body.prompt).toBe('a cat astronaut');
    expect((event.response as { Resp: { video_id: number } }).Resp.video_id).toBe(42);
    // The prompt is more useful in the list view than the raw envelope, so it wins.
    expect(event.summary).toBe('prompt: a cat astronaut');
  });

  it('falls back to the response envelope when the request has no prompt', async () => {
    const store = new EventStore();
    const fake: typeof fetch = async () => jsonResponse({ ErrCode: 0, ErrMsg: 'ok', Resp: { status: 1, video_id: 42 } });
    const wrapped = instrumentFetch(fake, store, 'pixverse');

    await wrapped('https://app-api.pixverse.ai/openapi/v2/video/result/42');

    const event = store.list().events[0];
    expect(event.summary).toContain('video_id=42');
    expect(event.summary).toContain('status=1');
  });

  it('redacts secrets in a URLSearchParams body (YouTube token refresh)', async () => {
    const store = new EventStore();
    const fake: typeof fetch = async () => jsonResponse({ access_token: 'abc' });
    const wrapped = instrumentFetch(fake, store, 'youtube');

    await wrapped('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({ client_id: 'id', client_secret: 'shh', refresh_token: 'shh2', grant_type: 'refresh_token' }),
    });

    const event = store.list().events[0];
    const body = (event.request as { body: Record<string, string> }).body;
    expect(body.client_secret).toBe('[redacted]');
    expect(body.refresh_token).toBe('[redacted]');
    expect(body.grant_type).toBe('refresh_token');
  });

  it('summarizes FormData uploads without buffering the file bytes', async () => {
    const store = new EventStore();
    const fake: typeof fetch = async () => jsonResponse({ ErrCode: 0, ErrMsg: 'ok', Resp: { img_id: 1, img_url: 'https://x/y.png' } });
    const wrapped = instrumentFetch(fake, store, 'pixverse');

    const form = new FormData();
    form.append('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'ref.png');
    await wrapped('https://app-api.pixverse.ai/openapi/v2/image/upload', { method: 'POST', body: form });

    const event = store.list().events[0];
    const body = (event.request as { body: { formData: Record<string, string> } }).body;
    expect(body.formData.image).toContain('ref.png');
    expect(body.formData.image).toContain('3 bytes');
  });

  it('does not buffer a binary response body', async () => {
    const store = new EventStore();
    const bytes = new Uint8Array(10);
    const fake: typeof fetch = async () => new Response(bytes, { status: 200, headers: { 'content-type': 'video/mp4' } });
    const wrapped = instrumentFetch(fake, store, 'youtube');

    const res = await wrapped('https://cdn.example.com/clip.mp4');
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBe(10); // caller still gets the real bytes

    const event = store.list().events[0];
    expect(typeof event.response).toBe('string');
    expect(event.response as string).toContain('binary response');
    expect(event.response as string).toContain('video/mp4');
  });

  it('marks a PixVerse business-level failure (ErrCode != 0) as an error even on HTTP 200', async () => {
    const store = new EventStore();
    const fake: typeof fetch = async () => jsonResponse({ ErrCode: 500, ErrMsg: 'invalid prompt', Resp: {} });
    const wrapped = instrumentFetch(fake, store, 'pixverse');

    await wrapped('https://app-api.pixverse.ai/openapi/v2/video/text/generate', { method: 'POST', body: '{}' });

    const event = store.list().events[0];
    expect(event.status).toBe('error');
    expect(event.httpStatus).toBe(200);
  });

  it('records a network failure and rethrows it to the caller', async () => {
    const store = new EventStore();
    const fake: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const wrapped = instrumentFetch(fake, store, 'claude');

    await expect(wrapped('http://localhost:8757/api/v1/claude/prompt', { method: 'POST' })).rejects.toThrow('ECONNREFUSED');

    const event = store.list().events[0];
    expect(event.status).toBe('error');
    expect(event.error).toBe('ECONNREFUSED');
    expect(event.httpStatus).toBeUndefined();
  });
});
