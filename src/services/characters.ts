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
  ReferenceAssetType,
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

const REFERENCE_TYPES: ReferenceAssetType[] = ['character', 'location'];

/** Strip the trailing canon-version suffix so ids from different versions compare equal. */
export function entityBase(id: string): string {
  return id.replace(/_\d+$/, '');
}

/**
 * Find the current-canon entity for a reference id, tolerating a version drift:
 * a re-extraction renumbers ids (`CHAR_BOBO_001` → `CHAR_BOBO_002`), so an id
 * from an earlier version still resolves to the same-named current entity.
 */
function findCurrentEntity(canon: CanonVersion | null, entityId: string): CanonEntity | undefined {
  if (!canon) return undefined;
  const refs = canon.entities.filter((e) => (REFERENCE_TYPES as string[]).includes(e.type));
  return refs.find((e) => e.id === entityId) ?? refs.find((e) => entityBase(e.id) === entityBase(entityId));
}

function requireCanonReferenceEntity(canon: CanonVersion | null, entityId: string): CanonEntity {
  const entity = findCurrentEntity(canon, entityId);
  if (!entity) throw new UserInputError(`No canon character or location with id ${entityId}. Extract canon first.`);
  return entity;
}

function styleMark(canon: CanonVersion | null): string {
  const style = canon?.entities.find((e) => e.type === 'visual_style');
  const mark = style?.marks.find((m) => /style|render|animation/i.test(m.key) && !/background|backdrop/i.test(m.key));
  return mark?.value ?? '';
}

/**
 * The single, canon-defined backdrop every character reference image should use
 * so the whole cast reads as one consistent set. Falls back to a fixed neutral
 * studio when the canon has not defined one.
 */
function referenceBackground(canon: CanonVersion | null): string {
  const style = canon?.entities.find((e) => e.type === 'visual_style');
  const mark = style?.marks.find((m) => /reference_background|backdrop|background/i.test(m.key));
  return mark?.value?.trim() || 'plain seamless neutral studio backdrop, warm neutral grey, even soft key light, subtle floor shadow';
}

/**
 * Marks that describe how a character behaves rather than how it looks —
 * useless (and sometimes actively confusing) in a still-image render prompt.
 * Note "never" is deliberately NOT excluded here: a "never change" mark is
 * exactly the kind of hard identity constraint the render needs to see.
 */
const NON_VISUAL_MARK = /personality|voice|movement|catchphrase/i;

/** PixVerse rejects prompts over 2048 chars; keep a safety margin below that. */
const MAX_PROMPT_CHARS = 2000;

/**
 * Join prompt fragments (highest-priority first) without exceeding the char
 * budget. Lower-priority fragments are skipped — not truncated mid-sentence —
 * so a locked identity feature is never dropped in favour of a filler
 * descriptor. A final hard clamp guards against any single oversized fragment.
 */
function joinWithinBudget(parts: Array<string | undefined>, max = MAX_PROMPT_CHARS): string {
  const kept: string[] = [];
  let len = 0;
  for (const raw of parts) {
    const p = raw?.trim();
    if (!p) continue;
    const add = (kept.length ? 1 : 0) + p.length;
    if (kept.length && len + add > max) continue; // skip this one; a later, shorter fragment may still fit
    kept.push(p);
    len += add;
  }
  const out = kept.join(' ');
  return out.length > max ? `${out.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : out;
}

/** Build a reference-sheet prompt from a character's canon marks (priority-ordered, budget-capped). */
export function buildCharacterPortraitPrompt(entity: CanonEntity, canon: CanonVersion | null): string {
  const visual = entity.marks.filter((m) => !NON_VISUAL_MARK.test(m.key) && m.value);
  const locked = visual.filter((m) => m.severity === 'locked');
  const rest = visual.filter((m) => m.severity !== 'locked');
  const style = styleMark(canon);
  const background = referenceBackground(canon);

  // Ordered most- to least-important so the budget drops filler, never identity.
  return joinWithinBudget([
    // The same fixed backdrop for every character keeps the whole cast's reference set visually consistent.
    `Character reference sheet of ${entity.name}: full body, neutral A-pose, facing forward, centered on ${background}, no text.`,
    entity.summary,
    locked.length ? `Must-have identity features — never change these: ${locked.map((m) => m.value).join('; ')}.` : undefined,
    style ? `Rendered in this exact style: ${style}.` : undefined,
    'Clear, consistent, canonical character design suitable as a reference for future shots. Depict only this one character.',
    rest.length ? rest.map((m) => m.value).join('; ') : undefined,
  ]);
}

/** Build an establishing-shot reference prompt from a location's canon marks (priority-ordered, budget-capped). */
export function buildLocationReferencePrompt(entity: CanonEntity, canon: CanonVersion | null): string {
  const visual = entity.marks.filter((m) => !NON_VISUAL_MARK.test(m.key) && m.value);
  const locked = visual.filter((m) => m.severity === 'locked');
  const rest = visual.filter((m) => m.severity !== 'locked');
  const style = styleMark(canon);

  return joinWithinBudget([
    `Establishing shot of the location "${entity.name}": wide angle, empty of characters or people, even balanced lighting, no text.`,
    entity.summary,
    locked.length ? `Must-have fixed landmarks — never change these: ${locked.map((m) => m.value).join('; ')}.` : undefined,
    style ? `Rendered in this exact style: ${style}.` : undefined,
    'Clear, consistent, canonical environment design suitable as a reference for future shots.',
    rest.length ? rest.map((m) => m.value).join('; ') : undefined,
  ]);
}

/** Dispatches to the character or location prompt builder based on entity type. */
export function buildPortraitPrompt(entity: CanonEntity, canon: CanonVersion | null): string {
  return entity.type === 'location' ? buildLocationReferencePrompt(entity, canon) : buildCharacterPortraitPrompt(entity, canon);
}

const DEFAULT_NEGATIVE_CHARACTER = 'text, watermark, logo, multiple characters, extra limbs, distorted anatomy, blurry, cropped';
const DEFAULT_NEGATIVE_LOCATION = 'text, watermark, logo, characters, people, blurry, cropped, distorted geometry';

function defaultNegative(type: ReferenceAssetType): string {
  return type === 'location' ? DEFAULT_NEGATIVE_LOCATION : DEFAULT_NEGATIVE_CHARACTER;
}

function emptyRegistry(storyId: string): CharacterRegistry {
  return { storyId, characters: {} };
}

/**
 * Reconcile the reference registry with the current canon:
 * - every current character/location has exactly one asset;
 * - assets from an earlier canon version are **migrated** to the current id
 *   (base-id match), carrying their versions/approval forward — so re-extracting
 *   canon doesn't leave stale, definition-less duplicate tiles;
 * - orphaned assets (their entity was removed from canon) are dropped.
 * Every asset that survives resolves to a current-canon entity, so all of them
 * have a definition.
 */
export function syncCharactersFromCanon(store: Store, storyId: string): CharacterRegistry {
  const canon = currentCanonVersion(store.getCanonRegistry(storyId));
  const registry = store.getCharacterRegistry(storyId) ?? emptyRegistry(storyId);
  if (!canon) return store.saveCharacterRegistry(registry);

  const currentEntities = canon.entities.filter((e) => (REFERENCE_TYPES as string[]).includes(e.type));
  const rebuilt: Record<string, CharacterAsset> = {};
  const oldAssets = Object.values(registry.characters);

  for (const entity of currentEntities) {
    // Prefer an exact-id asset; else migrate a prior-version asset with the same base id.
    const prior =
      registry.characters[entity.id] ?? oldAssets.find((a) => entityBase(a.entityId) === entityBase(entity.id));
    rebuilt[entity.id] = prior
      ? { ...prior, entityId: entity.id, type: entity.type as ReferenceAssetType, name: entity.name }
      : { entityId: entity.id, type: entity.type as ReferenceAssetType, name: entity.name, approvedVersionId: null, versions: [] };
  }

  registry.characters = rebuilt;
  return store.saveCharacterRegistry(registry);
}

function getAsset(registry: CharacterRegistry, entityId: string): CharacterAsset {
  const asset = registry.characters[entityId] ?? Object.values(registry.characters).find((a) => entityBase(a.entityId) === entityBase(entityId));
  if (!asset) throw new UserInputError(`Unknown reference asset ${entityId}. Sync characters first.`);
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
  /** Seed the render from an already-uploaded PixVerse image (image-to-video tweak). */
  sourceImageId?: number;
  sourceImageUrl?: string;
  /** Raw image bytes to upload first, then use as the image-to-video source. */
  sourceImageBytes?: Uint8Array;
  sourceImageFilename?: string;
  sourceImageContentType?: string;
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
  const entity = requireCanonReferenceEntity(canon, entityId);

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
    negativePrompt: options.negativePrompt ?? defaultNegative(asset.type),
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
    imageError: null,
    sourceImageUrl: options.sourceImageUrl ?? null,
    error: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
  };
  asset.versions.push(version);
  store.saveCharacterRegistry(registry);

  try {
    // If an input image is supplied (upload bytes or a pre-uploaded id), seed the
    // render with image-to-video so the tweak stays anchored to that image.
    let sourceImageId = options.sourceImageId;
    if (sourceImageId == null && options.sourceImageBytes) {
      const uploaded = await pixverse.uploadImage(
        options.sourceImageBytes,
        options.sourceImageFilename,
        options.sourceImageContentType,
      );
      sourceImageId = uploaded.imgId;
      version.sourceImageUrl = uploaded.imgUrl;
      store.saveCharacterRegistry(registry);
    }

    const videoId =
      sourceImageId != null
        ? await pixverse.generateImageToVideo({
            imageId: sourceImageId,
            prompt: version.prompt,
            model: version.model as never,
            quality: version.quality as never,
            duration: PORTRAIT_DEFAULTS.duration,
            motionMode: PORTRAIT_DEFAULTS.motionMode,
            negativePrompt: version.negativePrompt,
          })
        : await pixverse.generateTextToVideo({
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

      // Derive a still and upload it for image-to-video use; failures are
      // surfaced on the version (imageError) rather than swallowed, so a
      // missing image is visible and debuggable instead of just absent.
      if (version.status === 'ready' && result.url) {
        const frame = await extractFirstFrame(result.url, options.fetchImpl ?? fetch);
        if (frame.ok) {
          try {
            const uploaded = await pixverse.uploadImage(frame.bytes, `${entity.name}-ref.png`, 'image/png');
            version.imageId = uploaded.imgId;
            version.imageUrl = uploaded.imgUrl;
            version.imageError = null;
          } catch (err) {
            version.imageError = `Still captured but upload to PixVerse failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        } else {
          version.imageError = frame.reason;
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
    if (frame.ok) {
      try {
        const up = await pixverse.uploadImage(frame.bytes, 'ref.png', 'image/png');
        version.imageId = up.imgId;
        version.imageUrl = up.imgUrl;
        version.imageError = null;
      } catch (err) {
        version.imageError = `Still captured but upload to PixVerse failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else {
      version.imageError = frame.reason;
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
    imageError: null,
    sourceImageUrl: null,
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

export interface ReferenceDefinition {
  entityId: string;
  name: string;
  type: ReferenceAssetType;
  summary: string;
  /** Canon marks that define this character/location. */
  marks: Array<{ key: string; value: string; severity: string }>;
  /** The prompt that would be built from canon (before any tweak). */
  builtPrompt: string;
  negativePrompt: string;
  /** The prompt actually used by the approved/last render, if any. */
  currentPrompt: string | null;
}

/**
 * The full definition of a reference asset — its canon marks plus the render
 * prompt built from them — so it can be reviewed and the prompt edited before
 * spending credits on generation.
 */
export function buildReferenceDefinition(store: Store, storyId: string, entityId: string): ReferenceDefinition {
  store.getStory(storyId);
  const canon = currentCanonVersion(store.getCanonRegistry(storyId));
  const entity = requireCanonReferenceEntity(canon, entityId);
  const type = entity.type as ReferenceAssetType;
  const asset = store.getCharacterRegistry(storyId)?.characters[entityId];
  const current = asset ? (getApprovedVersion(asset) ?? asset.versions[asset.versions.length - 1] ?? null) : null;
  return {
    entityId,
    name: entity.name,
    type,
    summary: entity.summary,
    marks: entity.marks.map((m) => ({ key: m.key, value: m.value, severity: m.severity })),
    builtPrompt: buildPortraitPrompt(entity, canon),
    negativePrompt: defaultNegative(type),
    currentPrompt: current?.prompt ?? null,
  };
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
export function resolveSceneReferences(
  store: Store,
  storyId: string,
  referenceCharacterIds: string[],
  primaryReferenceId?: string | null,
): ResolvedReferences {
  const registry = store.getCharacterRegistry(storyId);
  const canon = currentCanonVersion(store.getCanonRegistry(storyId));
  const out: ResolvedReferences = { imageId: null, imageUrl: null, descriptors: [], usedCharacterIds: [] };
  if (!registry) return out;
  const primaryBase = primaryReferenceId ? entityBase(primaryReferenceId) : null;
  for (const id of referenceCharacterIds) {
    // A scene may reference an id from an earlier canon version; match by base id too.
    const asset = registry.characters[id] ?? Object.values(registry.characters).find((a) => entityBase(a.entityId) === entityBase(id));
    if (!asset) continue;
    const approved = getApprovedVersion(asset);
    if (!approved) continue;
    out.usedCharacterIds.push(id);
    const canonDesc = canon?.entities.find((e) => e.id === id)?.summary;
    out.descriptors.push({ name: asset.name, descriptor: approved.prompt || canonDesc || asset.name });
    if (approved.imageId != null) {
      // The chosen primary reference's image wins as the image-to-video seed;
      // otherwise the first approved image is used.
      const isPrimary = primaryBase != null && entityBase(id) === primaryBase;
      if (out.imageId == null || isPrimary) {
        out.imageId = approved.imageId;
        out.imageUrl = approved.imageUrl;
      }
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

/**
 * Detect every referenceable canon entity (characters AND locations) named in a
 * scene's text, so scenes auto-link to the reference images the director should
 * review before rendering. Characters lead, then locations.
 */
export function detectSceneReferences(store: Store, story: Story, text: string): string[] {
  const canon = currentCanonVersion(store.getCanonRegistry(story.id));
  if (!canon) return [];
  const lower = text.toLowerCase();
  const hit = (e: { name: string }) => e.name.trim().length > 1 && lower.includes(e.name.toLowerCase());
  const characters = canon.entities.filter((e) => e.type === 'character' && hit(e)).map((e) => e.id);
  const locations = canon.entities.filter((e) => e.type === 'location' && hit(e)).map((e) => e.id);
  return [...characters, ...locations];
}

export interface ReferenceReadinessItem {
  entityId: string;
  name: string;
  type: string;
  /** True when the referenced asset has an approved portrait/still to send to PixVerse. */
  approved: boolean;
  /** A thumbnail (image or video preview) for the approved-or-latest version, when present. */
  thumbnailUrl: string | null;
  /** The most recent version id (approve it inline), or null when nothing has been generated yet. */
  latestVersionId: string | null;
  /** The scenes (1-based numbers) that reference this entity. */
  scenes: number[];
}

export interface ReferenceReadiness {
  items: ReferenceReadinessItem[];
  /** Referenced entities that have no approved reference image yet. */
  unapproved: ReferenceReadinessItem[];
  ready: boolean;
}

/**
 * Report, for a storyline, every character/location its scenes reference and
 * whether each has an approved reference image — the data behind the pre-render
 * approval gate. When something is unreferenced-but-unapproved the render still
 * works (it falls back to text-to-video), so this is a warning, not a hard block.
 */
export function referenceReadiness(store: Store, storylineId: string): ReferenceReadiness {
  const project = store.getProject(storylineId);
  const storyId = project.storyline.storyId;
  const registry = store.getCharacterRegistry(storyId);
  const canon = currentCanonVersion(store.getCanonRegistry(storyId));
  const scenes = [...project.storyline.scenes].sort((a, b) => a.order - b.order);

  const byEntity = new Map<string, ReferenceReadinessItem>();
  scenes.forEach((scene, i) => {
    for (const id of scene.referenceCharacterIds ?? []) {
      const asset =
        registry?.characters[id] ??
        (registry ? Object.values(registry.characters).find((a) => entityBase(a.entityId) === entityBase(id)) : undefined);
      const canonEntity = canon?.entities.find((e) => e.id === id || entityBase(e.id) === entityBase(id));
      const name = asset?.name ?? canonEntity?.name ?? id;
      const type = asset?.type ?? canonEntity?.type ?? 'character';
      const approvedVersion = asset ? getApprovedVersion(asset) : null;
      const latestVersion = asset && asset.versions.length > 0 ? asset.versions[asset.versions.length - 1] : null;
      const thumb = approvedVersion ?? latestVersion;
      const existing = byEntity.get(entityBase(id));
      if (existing) {
        existing.scenes.push(i + 1);
      } else {
        byEntity.set(entityBase(id), {
          entityId: asset?.entityId ?? id,
          name,
          type,
          approved: Boolean(approvedVersion),
          thumbnailUrl: thumb?.imageUrl ?? thumb?.previewUrl ?? null,
          latestVersionId: latestVersion?.id ?? null,
          scenes: [i + 1],
        });
      }
    }
  });

  const items = [...byEntity.values()];
  const unapproved = items.filter((it) => !it.approved);
  return { items, unapproved, ready: unapproved.length === 0 };
}
