import path from 'node:path';
import { createApp, defaultWebDir } from './app';
import { createGatewayClaudeClient } from './clients/claudeGateway';
import { PixverseClient } from './clients/pixverse';
import { YoutubeClient } from './clients/youtube';
import { loadConfig } from './config';
import { loadEnvFile } from './env';
import { createPixverseProvider } from './costs/pricing';
import { EventStore } from './events/eventStore';
import { instrumentFetch } from './events/instrument';
import { JobRunner } from './services/jobs';
import { Store } from './store/store';

function main(): void {
  // Load .env before reading config (real env vars still take precedence).
  loadEnvFile();
  const config = loadConfig();

  if (!config.pixverse.apiKey) {
    console.warn('[warn] PIXVERSE_API_KEY is not set — video generation calls will fail until it is configured.');
  }
  const store = new Store(config.dataDir);

  // Audit trail of every outbound network call (LLM + PixVerse + YouTube),
  // persisted locally so the log survives a restart.
  const eventStore = new EventStore({ filePath: path.join(config.dataDir, 'events.jsonl') });

  // Storylines are generated through the local Claude Code Gateway rather than
  // the Anthropic API directly; the gateway supplies its own CLI auth.
  const claude = createGatewayClaudeClient({
    baseUrl: config.claudeGateway.baseUrl,
    fetchImpl: instrumentFetch(fetch, eventStore, 'claude'),
  });

  const pixverse = new PixverseClient({
    // Fall back to a placeholder so the server still boots without a key
    // (video calls will fail clearly); `||` also guards an empty-string value.
    apiKey: config.pixverse.apiKey || 'unset',
    baseUrl: config.pixverse.baseUrl,
    fetchImpl: instrumentFetch(fetch, eventStore, 'pixverse', {
      pixverse: createPixverseProvider(config.pixverse.creditUsd),
    }),
  });

  const youtube = new YoutubeClient({
    dryRun: config.youtube.dryRun,
    credentials:
      config.youtube.clientId && config.youtube.clientSecret && config.youtube.refreshToken
        ? {
            clientId: config.youtube.clientId,
            clientSecret: config.youtube.clientSecret,
            refreshToken: config.youtube.refreshToken,
          }
        : undefined,
    fetchImpl: instrumentFetch(fetch, eventStore, 'youtube'),
  });

  // Background job runner: async renders complete server-side even if every
  // browser tab is closed; resume() re-tracks in-flight renders after a restart.
  const jobs = new JobRunner({ store, pixverse });
  const resumed = jobs.resume();
  jobs.start();

  const app = createApp({ store, claude, pixverse, youtube, eventStore, jobs, webDir: defaultWebDir() });

  const server = app.listen(config.port, () => {
    console.log(`Backlot server listening on http://localhost:${config.port}`);
    console.log(`  data dir: ${config.dataDir}`);
    console.log(`  claude:   via gateway ${config.claudeGateway.baseUrl}`);
    console.log(`  youtube:  ${config.youtube.dryRun ? 'dry-run (no real uploads)' : 'live'}`);
    console.log(`  events:   ${path.join(config.dataDir, 'events.jsonl')}`);
    console.log(`  jobs:     background render polling every 5s${resumed ? ` (resumed ${resumed} in-flight)` : ''}`);
  });
  // Long LLM calls (drift check, storyline generation) can run for several
  // minutes. Node's default 5-minute requestTimeout would abort them and the
  // browser would see a bare "Failed to fetch" — disable it so these complete.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
}

main();
