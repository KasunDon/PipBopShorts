/**
 * Test safety net: the suite must NEVER hit a real external API — real calls
 * cost money (PixVerse credits, LLM tokens). Everything is covered by fakes
 * (see tests/helpers.ts); this guard replaces global fetch so any external
 * request that slips through fails loudly instead of silently billing us.
 *
 * Local requests (supertest servers, 127.0.0.1) are allowed.
 */
const realFetch = globalThis.fetch;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : ((input as Request).url ?? String(input));
  let hostname = '';
  try {
    hostname = new URL(url).hostname;
  } catch {
    // Relative URLs have no host — they can only be local.
  }
  if (hostname && !LOCAL_HOSTS.has(hostname)) {
    throw new Error(
      `Blocked external network call in tests: ${url}\n` +
        'Tests must never hit real APIs (they cost money). Inject a fake via fetchImpl — see tests/helpers.ts.',
    );
  }
  return realFetch(input, init);
}) as typeof fetch;
