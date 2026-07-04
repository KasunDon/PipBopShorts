import path from 'node:path';

export interface AppConfig {
  port: number;
  dataDir: string;
  pixverse: {
    apiKey: string | undefined;
    baseUrl: string;
    /** USD per PixVerse credit, for cost accounting. Tune to your plan. */
    creditUsd: number;
  };
  claudeGateway: {
    baseUrl: string;
  };
  youtube: {
    clientId: string | undefined;
    clientSecret: string | undefined;
    refreshToken: string | undefined;
    dryRun: boolean;
  };
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const youtubeCredsPresent = Boolean(
    env.YOUTUBE_CLIENT_ID && env.YOUTUBE_CLIENT_SECRET && env.YOUTUBE_REFRESH_TOKEN,
  );
  return {
    port: Number(env.PORT ?? 4000),
    dataDir: path.resolve(env.DATA_DIR ?? './data'),
    pixverse: {
      apiKey: env.PIXVERSE_API_KEY,
      baseUrl: (env.PIXVERSE_BASE_URL ?? 'https://app-api.pixverse.ai/openapi/v2').replace(/\/$/, ''),
      creditUsd: Number(env.PIXVERSE_CREDIT_USD ?? 0.012) || 0.012,
    },
    claudeGateway: {
      // Local Claude Code Gateway (HTTP wrapper around the `claude` CLI).
      baseUrl: (env.CLAUDE_GATEWAY_URL ?? 'http://localhost:8757').replace(/\/$/, ''),
    },
    youtube: {
      clientId: env.YOUTUBE_CLIENT_ID,
      clientSecret: env.YOUTUBE_CLIENT_SECRET,
      refreshToken: env.YOUTUBE_REFRESH_TOKEN,
      // Dry-run when explicitly requested, or when credentials are incomplete.
      dryRun: bool(env.YOUTUBE_DRY_RUN) || !youtubeCredsPresent,
    },
  };
}
