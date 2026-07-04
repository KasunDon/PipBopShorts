import type { YoutubeClient } from '../clients/youtube';
import type { Store } from '../store/store';
import type { Clip, Project, PublishRecord, Scene } from '../types';
import { stitchClips } from './stitch';

export interface PublishOptions {
  privacyStatus?: 'public' | 'unlisted' | 'private';
  /** Publish a specific scene's clip. */
  sceneId?: string;
  /** Explicit video URL to publish (overrides scene selection). */
  videoUrl?: string;
  /** Attempt to concatenate all ready clips into one video (requires ffmpeg). */
  stitch?: boolean;
  fetchImpl?: typeof fetch;
}

function readyClipsInOrder(project: Project): Array<{ scene: Scene; clip: Clip }> {
  return [...project.storyline.scenes]
    .sort((a, b) => a.order - b.order)
    .map((scene) => ({ scene, clip: project.clips[scene.id] }))
    .filter((x): x is { scene: Scene; clip: Clip } => Boolean(x.clip) && x.clip.status === 'ready' && Boolean(x.clip.url));
}

function composeDescription(project: Project): string {
  const { description, hashtags } = project.storyline.youtube;
  const tagsLine = hashtags.filter(Boolean).join(' ');
  return tagsLine ? `${description}\n\n${tagsLine}` : description;
}

/**
 * Publish a project's short to YouTube. Chooses the video to upload from the
 * explicit URL, a named scene, a single ready clip, or a stitched concat of all
 * ready clips (when ffmpeg is available). Runs as a no-op "dry run" when
 * YouTube credentials are not configured.
 */
export async function publishProject(
  store: Store,
  youtube: YoutubeClient,
  storylineId: string,
  options: PublishOptions = {},
): Promise<PublishRecord> {
  const project = store.getProject(storylineId);

  let videoUrl: string | undefined = options.videoUrl;
  let videoBytes: Uint8Array | undefined;

  if (!videoUrl) {
    if (options.sceneId) {
      const clip = project.clips[options.sceneId];
      if (!clip || clip.status !== 'ready' || !clip.url) {
        throw new Error('Selected scene has no rendered clip to publish');
      }
      videoUrl = clip.url;
    } else {
      const ready = readyClipsInOrder(project);
      if (ready.length === 0) {
        throw new Error('No ready clips to publish. Generate the scenes first.');
      }
      if (ready.length > 1 && options.stitch && !youtube.isDryRun) {
        const stitched = await stitchClips(
          ready.map((r) => r.clip.url as string),
          options.fetchImpl,
        );
        if (stitched) videoBytes = stitched;
      }
      if (!videoBytes) videoUrl = ready[0].clip.url as string;
    }
  }

  const record: PublishRecord = {
    status: 'publishing',
    provider: 'youtube',
    dryRun: youtube.isDryRun,
    videoId: null,
    url: null,
    error: null,
    publishedAt: null,
  };
  project.publish = record;
  store.saveProject(project);

  try {
    const result = await youtube.uploadShort({
      title: project.storyline.youtube.title,
      description: composeDescription(project),
      tags: project.storyline.youtube.tags,
      privacyStatus: options.privacyStatus ?? 'private',
      videoUrl,
      videoBytes,
    });
    record.status = 'published';
    record.videoId = result.videoId;
    record.url = result.url;
    record.dryRun = result.dryRun;
    record.publishedAt = new Date().toISOString();
  } catch (err) {
    record.status = 'failed';
    record.error = err instanceof Error ? err.message : String(err);
  }
  project.publish = record;
  // Append the completed attempt to the publish history (a snapshot, so later
  // publishes don't mutate past entries).
  project.publishHistory = [...(project.publishHistory ?? []), { ...record }];
  store.saveProject(project);
  return record;
}
