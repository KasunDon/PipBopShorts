import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventStore, type RecordInput } from '../src/events/eventStore';

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipbop-events-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'events.jsonl');
}

function sampleInput(overrides: Partial<RecordInput> = {}): RecordInput {
  return {
    durationMs: 12,
    service: 'pixverse',
    type: 'pixverse.video.result',
    method: 'GET',
    url: 'https://app-api.pixverse.ai/openapi/v2/video/result/123',
    status: 'ok',
    httpStatus: 200,
    summary: 'ok status=1',
    request: { headers: {} },
    response: { ErrMsg: 'ok', Resp: { status: 1 } },
    ...overrides,
  };
}

describe('EventStore', () => {
  it('assigns id/ts on record and lists newest first', () => {
    const store = new EventStore();
    const a = store.record(sampleInput({ summary: 'first' }));
    const b = store.record(sampleInput({ summary: 'second' }));
    expect(a.id).toBeTruthy();
    expect(a.ts).toBeTruthy();
    const { events } = store.list();
    expect(events.map((e) => e.summary)).toEqual(['second', 'first']);
    expect(b.id).not.toBe(a.id);
  });

  it('gets a single event by id', () => {
    const store = new EventStore();
    const a = store.record(sampleInput());
    expect(store.get(a.id)?.id).toBe(a.id);
    expect(store.get('missing')).toBeUndefined();
  });

  it('filters by service and status', () => {
    const store = new EventStore();
    store.record(sampleInput({ service: 'pixverse', status: 'ok' }));
    store.record(sampleInput({ service: 'claude', status: 'error', summary: 'refused' }));
    expect(store.list({ service: 'claude' }).events).toHaveLength(1);
    expect(store.list({ status: 'error' }).events[0].summary).toBe('refused');
  });

  it('searches text across summary, url, request and response', () => {
    const store = new EventStore();
    store.record(sampleInput({ summary: 'prompt: cat astronaut', url: 'http://x/prompt' }));
    store.record(sampleInput({ summary: 'unrelated', response: { note: 'mentions zebra somewhere' } }));
    expect(store.list({ q: 'astronaut' }).events).toHaveLength(1);
    expect(store.list({ q: 'zebra' }).events).toHaveLength(1);
    expect(store.list({ q: 'nope-not-present' }).events).toHaveLength(0);
  });

  it('paginates with before/limit and reports hasMore', () => {
    const store = new EventStore();
    const ids = Array.from({ length: 5 }, (_, i) => store.record(sampleInput({ summary: `e${i}` })).id);
    const page1 = store.list({ limit: 2 });
    expect(page1.events.map((e) => e.summary)).toEqual(['e4', 'e3']);
    expect(page1.hasMore).toBe(true);

    const page2 = store.list({ limit: 2, before: page1.events[1].id });
    expect(page2.events.map((e) => e.summary)).toEqual(['e2', 'e1']);
    expect(page2.hasMore).toBe(true);

    const page3 = store.list({ limit: 10, before: page2.events[1].id });
    expect(page3.events.map((e) => e.summary)).toEqual(['e0']);
    expect(page3.hasMore).toBe(false);
    expect(ids).toHaveLength(5);
  });

  it('clears all events', () => {
    const store = new EventStore();
    store.record(sampleInput());
    store.clear();
    expect(store.list().events).toHaveLength(0);
  });

  it('emits a real-time event on record and subscribe/unsubscribe works', () => {
    const store = new EventStore();
    const seen: string[] = [];
    const unsubscribe = store.subscribe((e) => seen.push(e.summary));
    store.record(sampleInput({ summary: 'one' }));
    unsubscribe();
    store.record(sampleInput({ summary: 'two' }));
    expect(seen).toEqual(['one']);
  });

  it('persists to disk and reloads on construction', () => {
    const filePath = tmpFile();
    const store1 = new EventStore({ filePath });
    store1.record(sampleInput({ summary: 'persisted-1' }));
    store1.record(sampleInput({ summary: 'persisted-2' }));

    const store2 = new EventStore({ filePath });
    expect(store2.list().events.map((e) => e.summary)).toEqual(['persisted-2', 'persisted-1']);
  });

  it('caps in-memory events at maxEvents, dropping the oldest', () => {
    const store = new EventStore({ maxEvents: 3 });
    for (let i = 0; i < 5; i++) store.record(sampleInput({ summary: `e${i}` }));
    const { events } = store.list({ limit: 100 });
    expect(events.map((e) => e.summary)).toEqual(['e4', 'e3', 'e2']);
  });
});
