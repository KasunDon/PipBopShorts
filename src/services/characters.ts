import { PixverseError, type PixverseClient } from '../clients/pixverse';
import { UserInputError } from '../errors';
import type { Store } from '../store/store';
import { makeId } from '../store/store';
import type {
  CanonEntity,
  CanonVersion,
  CharacterAsset,
  CharacterRegistry,
  PortraitSource,
  PortraitStatus,
  PortraitVersion,
  Story,
} from '../types';
import { currentCanonVersion } from './canon';
import { extractFirstFrame } from './frame';

/** Default render parameters for a character reference portrait. */
export const PORTRAIT_DEFAULTS = {
  model: 'v5',
  quality: '720p',
  aspectRatio: '9:16',
  duration: 5 as const,
  motionMode: 'normal' as const,
  style: 'none',
};

function requireCanonCharacter(canon: CanonVersion | null, entityId: string): CanonEntity {
  const entity = canon?.entities.find((e) => e.id === entityId && e.type === 'character');
  if (!entity) throw new UserInputError(`No canon character with id ${entityId}. Extract canon first.`);
  return entity;
}

function styleMark(canon: CanonVersion | null): string {
  const style = canon?.entities.find((e) => e.type === 'visual_style');
  const mark = style?.marks.find((m) => /style|render|animation/i.test(m.key));
  return mark?.value ?? '';
}

/** Build a reference-sheet prompt from a character's canon marks. */
export function buildPortraitPrompt(entity: CanonEntity, canon: CanonVersion | null): string {
  const descriptors = entity.marks
    .filter((m) => !/personality|voice|movement|catchphrase|never/i.test(m.key))
    .map((m) => m.value)
    .filter(Boolean);
  const style = styleMark(canon);
  const parts = [
    `Character reference sheet of ${entity.name}: full body, neutral A-pose, facing forward, centered on a plain neutral studio background, even soft lighting, no text.`,
    entity.summary,
    descriptors.join('; '),
  ].filter(Boolean);
  if (style) parts.push(`Rendered in this exact style: ${style}.`);
  parts.push('Clear, consistent, canonical character design suitable as a reference for future shots.');
  return parts.join(' ');
}

const DEFAULT_NEGATIVE = 'text, watermark, logo, multiple characters, extra limbs, distorted anatomy, blurry, cropped';

function emptyRegistry(storyId: string): CharacterRegistry {
  return { storyId, characters: {} };
}

/** Ensure a character asset exists for every canon character; returns the registry. */
export function syncCharactersFromCanon(store: Store, storyId: string): CharacterRegistry {
  const canon = currentCanonVersion(store.getCanonRegistry(storyId));
  const registry = store.getCharacterRegistry(storyId) ?? emptyRegistry(storyId);
  if (!canon) return store.saveCharacterRegistry(registry);
  for (const entity of canon.entities.filter((e) => e.type === 'character')) {
    if (!registry.characters[entity.id]) {
      registry.characters[entity.id] = {
        entityId: entity.id,
        name: entity.name,
        approvedVersionId: null,
        versions: [],
      };
    } else {
      registry.characters[entity.id].name = entity.name; // keep display name fresh
    }
  }
  return store.saveCharacterRegistry(registry);
}

function getAsset(registry: CharacterRegistry, entityId: string): CharacterAsset {
  const asset = registry.characters[entityId];
  if (!asset) throw new UserInputError(`Unknown character asset ${entityId}. Sync characters first.`);
  return asset;
}

export interface GeneratePortraitOptions {
  /** 'auto' builds the prompt from canon; provide promptOverride for 'tweak'. */
  source?: PortraitSource;
  promptOverride?: string;
  negativePrompt?: string;
  model?: string;
  quality?: string;
  aspectRatio?: string;
  style?: string;
  wait?: boolean;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable fetch for frame extraction (tests). */
  fetchImpl?: typeof fetch;
}

function statusFromLabel(label: string): PortraitStatus {
  if (label === 'succeeded') return 'ready';
  if (label === 'moderation_failed') return 'moderation_failed';
  if (label === 'failed' || label === 'deleted') return 'failed';
  return 'generating';
}

/**
 * Generate (or refresh/tweak) a character reference portrait as a new version.
 * Renders via PixVerse text-to-video, then — when possible — derives a still
 * image (first frame) and uploads it so scenes can use it as an image-to-video
 * source. Every call appends a new, immutable version.
 */
export async function generatePortrait(
  store: Store,
  pixverse: PixverseClient,
  storyId: string,
  entityId: string,
  options: GeneratePortraitOptions = {},
): Promise<PortraitVersion> {
  store.getStory(storyId);
  const canon = currentCanonVersion(store.getCanonRegistry(storyId));
  const entity = requireCanonCharacter(canon, entityId);

  const registry = syncCharactersFromCanon(store, storyId);
  const asset = getAsset(registry, entityId);

  const source: PortraitSource = options.source ?? (asset.versions.length === 0 ? 'auto' : 'refresh');
  let prompt = options.promptOverride?.trim();
  if (!prompt) {
    // refresh reuses the last prompt; auto/first builds from canon.
    prompt = asset.versions[asset.versions.length - 1]?.prompt ?? buildPortraitPrompt(entity, canon);
  }

  const version: PortraitVersion = {
    id: makeId('port'),
    version: asset.versions.length + 1,
    prompt,
    negativePrompt: options.negativePrompt ?? DEFAULT_NEGATIVE,
    model: options.model ?? PORTRAIT_DEFAULTS.model,
    quality: options.quality ?? PORTRAIT_DEFAULTS.quality,
    aspectRatio: options.aspectRatio ?? PORTRAIT_DEFAULTS.aspectRatio,
    style: options.style ?? PORTRAIT_DEFAULTS.style,
    source,
    status: 'generating',
    videoId: null,
    previewUrl: null,
    imageId: null,
    imageUrl: null,
    error: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
  };
  asset.versions.push(version);
  store.saveCharacterRegistry(registry);

  try {
    const videoId = await pixverse.generateTextToVideo({
      prompt: version.prompt,
      model: version.model as never,
      quality: version.quality as never,
      duration: PORTRAIT_DEFAULTS.duration,
      motionMode: PORTRAIT_DEFAULTS.motionMode,
      aspectRatio: version.aspectRatio as never,
      negativePrompt: version.negativePrompt,
      style: version.style as never,
    });
    version.videoId = videoId;
    store.saveCharacterRegistry(registry);

    if (options.wait !== false) {
      const result = await pixverse.pollVideo(videoId, {
        intervalMs: options.pollIntervalMs,
        timeoutMs: options.pollTimeoutMs,
        sleep: options.sleep,
      });
      version.status = statusFromLabel(result.statusLabel);
      version.previewUrl = result.url;
      version.finishedAt = new Date().toISOString();

      // Best-effort: derive a still and upload it for image-to-video use.
      if (version.status === 'ready' && result.url) {
        const frame = await extractFirstFrame(result.url, options.fetchImpl ?? fetch);
        if (frame) {
          try {
            const uploaded = await pixverse.uploadImage(frame, `${entity.name}-ref.png`, 'image/png');
            version.imageId = uploaded.imgId;
            version.imageUrl = uploaded.imgUrl;
          } catch {
            // Non-fatal: scenes fall back to descriptor-only references.
          }
        }
      }
    }
    store.saveCharacterRegistry(registry);
    return version;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    version.status = err instanceof PixverseError && /moderation/i.test(message) ? 'moderation_failed' : 'failed';
    version.error = message;
    version.finishedAt = new Date().toISOString();
    store.saveCharacterRegistry(registry);
    return version;
  }
}

/** Poll a still-generating portrait version and update it. */
export async function refreshPortrait(
  store: Store,
  pixverse: PixverseClient,
  storyId: string,
  entityId: string,
  versionId: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<PortraitVersion> {
  const registry = store.getCharacterRegistry(storyId);
  if (!registry) throw new UserInputError('No character registry.');
  const asset = getAsset(registry, entityId);
  const version = asset.versions.find((v) => v.id === versionId);
  if (!version) throw new UserInputError(`Portrait version not found: ${versionId}`);
  if (version.videoId == null || version.status !== 'generating') return version;

  const result = await pixverse.getVideoResult(version.videoId);
  version.status = statusFromLabel(result.statusLabel);
  if (result.url) version.previewUrl = result.url;
  if (version.status !== 'generating') version.finishedAt = new Date().toISOString();
  if (version.status === 'ready' && result.url && version.imageId == null) {
    const frame = await extractFirstFrame(result.url, options.fetchImpl ?? fetch);
    if (frame) {
      try {
        const up = await pixverse.uploadImage(frame, 'ref.png', 'image/png');
        version.imageId = up.imgId;
        version.imageUrl = up.imgUrl;
      } catch {
        /* non-fatal */
      }
    }
  }
  store.saveCharacterRegistry(registry);
  return version;
}

/** Upload a still directly as an approved-able reference version (real img_id). */
export async function uploadPortraitStill(
  store: Store,
  pixverse: PixverseClient,
  storyId: string,
  entityId: string,
  bytes: Uint8Array,
  filename?: string,
  contentType?: string,
): Promise<PortraitVersion> {
  const registry = syncCharactersFromCanon(store, storyId);
  const asset = getAsset(registry, entityId);
  const uploaded = await pixverse.uploadImage(bytes, filename, contentType);
  const version: PortraitVersion = {
    id: makeId('port'),
    version: asset.versions.length + 1,
    prompt: '(uploaded still)',
    negativePrompt: '',
    model: '',
    quality: '',
    aspectRatio: '',
    style: '',
    source: 'upload',
    status: 'ready',
    videoId: null,
    previewUrl: uploaded.imgUrl,
    imageId: uploaded.imgId,
    imageUrl: uploaded.imgUrl,
    error: null,
    createdAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  };
  asset.versions.push(version);
  store.saveCharacterRegistry(registry);
  return version;
}

/** Approve a specific version as the character's canonical reference. */
export function approvePortrait(store: Store, storyId: string, entityId: string, versionId: string): CharacterAsset {
  const registry = store.getCharacterRegistry(storyId);
  if (!registry) throw new UserInputError('No character registry.');
  const asset = getAsset(registry, entityId);
  const version = asset.versions.find((v) => v.id === versionId);
  if (!version) throw new UserInputError(`Portrait version not found: ${versionId}`);
  if (version.status !== 'ready') throw new UserInputError('Only a rendered (ready) version can be approved.');
  asset.approvedVersionId = versionId;
  store.saveCharacterRegistry(registry);
  return asset;
}

export function getApprovedVersion(asset: CharacterAsset): PortraitVersion | null {
  if (!asset.approvedVersionId) return null;
  return asset.versions.find((v) => v.id === asset.approvedVersionId) ?? null;
}

export interface ResolvedReferences {
  /** First approved image id available among the referenced characters. */
  imageId: number | null;
  imageUrl: string | null;
  /** Visual descriptors (approved prompts) for every referenced character. */
  descriptors: Array<{ name: string; descriptor: string }>;
  usedCharacterIds: string[];
}

/**
 * Resolve a scene's referenced characters into an image-to-video source (first
 * approved image) plus descriptors to inject into the prompt. This is what
 * actually sends the approved reference images to PixVerse at render time.
 */
export function resolveSceneReferences(store: Store, storyId: string, referenceCharacterIds: string[]): ResolvedReferences {
  const registry = store.getCharacterRegistry(storyId);
  const canon = currentCanonVersion(store.getCanonRegistry(storyId));
  const out: ResolvedReferences = { imageId: null, imageUrl: null, descriptors: [], usedCharacterIds: [] };
  if (!registry) return out;
  for (const id of referenceCharacterIds) {
    const asset = registry.characters[id];
    if (!asset) continue;
    const approved = getApprovedVersion(asset);
    if (!approved) continue;
    out.usedCharacterIds.push(id);
    const canonDesc = canon?.entities.find((e) => e.id === id)?.summary;
    out.descriptors.push({ name: asset.name, descriptor: approved.prompt || canonDesc || asset.name });
    if (out.imageId == null && approved.imageId != null) {
      out.imageId = approved.imageId;
      out.imageUrl = approved.imageUrl;
    }
  }
  return out;
}

/**
 * Detect which canon characters are named in a scene's text so scenes can be
 * auto-linked to their reference images.
 */
export function detectCharactersInText(store: Store, story: Story, text: string): string[] {
  const canon = currentCanonVersion(store.getCanonRegistry(story.id));
  if (!canon) return [];
  const lower = text.toLowerCase();
  return canon.entities
    .filter((e) => e.type === 'character' && e.name.trim().length > 1 && lower.includes(e.name.toLowerCase()))
    .map((e) => e.id);
}
