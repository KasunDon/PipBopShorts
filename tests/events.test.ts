import http from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp, type AppDeps } from '../src/app';
import { EventStore } from '../src/events/eventStore';
import { makeDryRunYoutube, makeFakeClaude, makeFakePixverse, makeStore, noSleep } from './helpers';

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

function makeApp(eventStore: EventStore) {
  const { store, cleanup } = makeStore();
  cleanups.push(cleanup);
  const { client: claude } = makeFakeClaude();
  const { client: pixverse } = makeFakePixverse({ defaultStatus: 1 });
  const deps: AppDeps = {
    store,
    claude,
    pixverse,
    youtube: makeDryRunYoutube(),
    generateDefaults: { pollIntervalMs: 1, sleep: noSleep },
    eventStore,
  };
  return createApp(deps);
}

function seed(store: EventStore, overrides: Partial<Parameters<EventStore['record']>[0]> = {}) {
  return store.record({
    durationMs: 5,
    service: 'pixverse',
    type: 'pixverse.video.result',
    method: 'GET',
    url: 'https://app-api.pixverse.ai/openapi/v2/video/result/1',
    status: 'ok',
    httpStatus: 200,
    summary: 'status=1',
    request: { headers: {} },
    response: { ErrMsg: 'ok', Resp: { status: 1 } },
    ...overrides,
  });
}

describe('audit events API', () => {
  it('lists events newest-first', async () => {
    const eventStore = new EventStore();
    seed(eventStore, { summary: 'first' });
    seed(eventStore, { summary: 'second' });
    const app = makeApp(eventStore);
    const res = await request(app).get('/api/events').expect(200);
    expect(res.body.events.map((e: { summary: string }) => e.summary)).toEqual(['second', 'first']);
  });

  it('filters by q and service', async () => {
    const eventStore = new EventStore();
    seed(eventStore, { summary: 'prompt: cat astronaut', service: 'claude' });
    seed(eventStore, { summary: 'text-to-video', service: 'pixverse' });
    const app = makeApp(eventStore);

    const byText = await request(app).get('/api/events?q=astronaut').expect(200);
    expect(byText.body.events).toHaveLength(1);

    const byService = await request(app).get('/api/events?service=pixverse').expect(200);
    expect(byService.body.events).toHaveLength(1);
    expect(byService.body.events[0].summary).toBe('text-to-video');
  });

  it('fetches a full raw event by id and 404s for a missing one', async () => {
    const eventStore = new EventStore();
    const event = seed(eventStore);
    const app = makeApp(eventStore);

    const ok = await request(app).get(`/api/events/${event.id}`).expect(200);
    expect(ok.body.event.id).toBe(event.id);
    expect(ok.body.event.response).toEqual(event.response);

    await request(app).get('/api/events/does-not-exist').expect(404);
  });

  it('clears all events', async () => {
    const eventStore = new EventStore();
    seed(eventStore);
    const app = makeApp(eventStore);
    await request(app).delete('/api/events').expect(204);
    const res = await request(app).get('/api/events').expect(200);
    expect(res.body.events).toHaveLength(0);
  });

  it('streams new events in real time over SSE', async () => {
    const eventStore = new EventStore();
    const app = makeApp(eventStore);
    const server = app.listen(0);
    cleanups.push(() => server.close());
    const port = (server.address() as AddressInfo).port;

    const received = await new Promise<string>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/api/events/stream`, (res) => {
        let buffer = '';
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          const dataLine = buffer.split('\n').find((l) => l.startsWith('data: '));
          if (dataLine) {
            req.destroy();
            resolve(dataLine.slice('data: '.length));
          }
        });
        res.on('error', reject);
      });
      req.on('error', () => {
        /* expected once we destroy() above */
      });
      // Give the connection a moment to establish before emitting.
      setTimeout(() => seed(eventStore, { summary: 'live-event' }), 50);
    });

    const parsed = JSON.parse(received);
    expect(parsed.summary).toBe('live-event');
  });
});
