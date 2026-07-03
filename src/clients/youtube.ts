type FetchLike = typeof fetch;

export interface YoutubeCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface YoutubeClientOptions {
  credentials?: YoutubeCredentials;
  dryRun: boolean;
  fetchImpl?: FetchLike;
}

export interface UploadShortInput {
  title: string;
  description: string;
  tags?: string[];
  privacyStatus?: 'public' | 'unlisted' | 'private';
  categoryId?: string;
  /** URL to fetch the rendered video from (e.g. a PixVerse clip URL). */
  videoUrl?: string;
  /** Raw video bytes (takes precedence over videoUrl). */
  videoBytes?: Uint8Array;
  contentType?: string;
}

export interface UploadShortResult {
  videoId: string;
  url: string | null;
  dryRun: boolean;
}

export class YoutubeError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'YoutubeError';
  }
}

/** Ensure the title/description carry the #Shorts marker YouTube uses to classify Shorts. */
function withShortsTag(text: string): string {
  return /#shorts/i.test(text) ? text : `${text} #Shorts`.trim();
}

export class YoutubeClient {
  private readonly credentials?: YoutubeCredentials;
  private readonly dryRun: boolean;
  private readonly fetchImpl: FetchLike;

  constructor(options: YoutubeClientOptions) {
    this.credentials = options.credentials;
    // Force dry-run when credentials are missing regardless of the flag.
    this.dryRun = options.dryRun || !options.credentials;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get isDryRun(): boolean {
    return this.dryRun;
  }

  private async accessToken(): Promise<string> {
    if (!this.credentials) throw new YoutubeError('YouTube credentials are not configured');
    const body = new URLSearchParams({
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      refresh_token: this.credentials.refreshToken,
      grant_type: 'refresh_token',
    });
    const res = await this.fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      throw new YoutubeError(`Token refresh failed: HTTP ${res.status} ${await res.text()}`, res.status);
    }
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) throw new YoutubeError('Token refresh returned no access_token');
    return json.access_token;
  }

  private async fetchVideoBytes(url: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new YoutubeError(`Failed to download video: HTTP ${res.status}`, res.status);
    const contentType = res.headers.get('content-type') ?? 'video/mp4';
    const buf = new Uint8Array(await res.arrayBuffer());
    return { bytes: buf, contentType };
  }

  async uploadShort(input: UploadShortInput): Promise<UploadShortResult> {
    const title = withShortsTag(input.title.slice(0, 100));
    const description = withShortsTag(input.description);

    if (this.dryRun) {
      return { videoId: `dry-run-${Date.now().toString(36)}`, url: null, dryRun: true };
    }

    let bytes = input.videoBytes;
    let contentType = input.contentType ?? 'video/mp4';
    if (!bytes) {
      if (!input.videoUrl) throw new YoutubeError('uploadShort requires videoBytes or videoUrl');
      const fetched = await this.fetchVideoBytes(input.videoUrl);
      bytes = fetched.bytes;
      contentType = input.contentType ?? fetched.contentType;
    }

    const token = await this.accessToken();
    const metadata = {
      snippet: {
        title,
        description,
        tags: input.tags ?? [],
        categoryId: input.categoryId ?? '22',
      },
      status: {
        privacyStatus: input.privacyStatus ?? 'private',
        selfDeclaredMadeForKids: false,
      },
    };

    // Step 1: initiate resumable upload.
    const initRes = await this.fetchImpl(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Upload-Content-Type': contentType,
          'X-Upload-Content-Length': String(bytes.length),
        },
        body: JSON.stringify(metadata),
      },
    );
    if (!initRes.ok) {
      throw new YoutubeError(`Resumable init failed: HTTP ${initRes.status} ${await initRes.text()}`, initRes.status);
    }
    const uploadUrl = initRes.headers.get('location');
    if (!uploadUrl) throw new YoutubeError('Resumable init returned no upload URL');

    // Step 2: upload the bytes.
    const putRes = await this.fetchImpl(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType, 'Content-Length': String(bytes.length) },
      body: bytes,
    });
    if (!putRes.ok) {
      throw new YoutubeError(`Upload failed: HTTP ${putRes.status} ${await putRes.text()}`, putRes.status);
    }
    const json = (await putRes.json()) as { id?: string };
    if (!json.id) throw new YoutubeError('Upload succeeded but returned no video id');
    return { videoId: json.id, url: `https://www.youtube.com/shorts/${json.id}`, dryRun: false };
  }
}
