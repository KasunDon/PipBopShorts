import { describe, expect, it } from 'vitest';
import { YoutubeClient } from '../src/clients/youtube';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('YoutubeClient.fetchAnalytics', () => {
  it('parses an analytics report when configured', async () => {
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) return jsonResponse({ access_token: 'tok' });
      if (url.includes('youtubeanalytics.googleapis.com')) {
        return jsonResponse({
          columnHeaders: [{ name: 'views' }, { name: 'likes' }, { name: 'averageViewPercentage' }],
          rows: [[9500, 320, 61]],
        });
      }
      return new Response('no', { status: 404 });
    }) as typeof fetch;

    const client = new YoutubeClient({
      dryRun: false,
      credentials: { clientId: 'a', clientSecret: 'b', refreshToken: 'c' },
      fetchImpl,
    });
    const analytics = await client.fetchAnalytics('VIDEO123');
    expect(analytics).toEqual({ views: 9500, likes: 320, avgViewPct: 61 });
  });

  it('returns null in dry-run and for dry-run video ids', async () => {
    const dry = new YoutubeClient({ dryRun: true });
    expect(await dry.fetchAnalytics('VIDEO123')).toBeNull();
    const configured = new YoutubeClient({
      dryRun: false,
      credentials: { clientId: 'a', clientSecret: 'b', refreshToken: 'c' },
      fetchImpl: (async () => new Response('no', { status: 500 })) as typeof fetch,
    });
    expect(await configured.fetchAnalytics('dry-run-abc')).toBeNull();
    // API failure → null (graceful).
    expect(await configured.fetchAnalytics('VIDEO123')).toBeNull();
  });
});
