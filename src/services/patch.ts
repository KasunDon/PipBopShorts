import { structuredCall, type AnthropicLike } from '../clients/claude';
import { collectValidationIssues } from '../clients/pixverse';
import type { ClaudeEffort } from '../constants';
import { UserInputError } from '../errors';
import type { Store } from '../store/store';
import { makeId } from '../store/store';
import type { Project, ScenePatch } from '../types';
import { buildCanonBlock, currentCanonVersion, DEFAULT_DISSECT_MODEL } from './canon';
import { idleClip } from './storyline';

const PATCH_SYSTEM = `You are a film-set supervisor applying a DIRECTED edit to one shot's prompt.
Treat the current prompt as an existing, approved film set: the director asks for ONE change and you change ONLY that, preserving everything else exactly — wardrobe, character designs, setting, lighting, camera, style, mood — unless the requested change unavoidably touches it.

Return the FULL revised prompt (not a diff), plus:
- "changed": one short sentence naming exactly what you altered.
- "preserved": the key elements you deliberately kept unchanged (so the operator can verify nothing else moved).
- "rationale": one line on how you kept the edit surgical.

Never introduce new characters, props, or style shifts the director didn't ask for. If the request would violate a canonical locked mark, keep canon and note that in "rationale".`;

function patchSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      new_prompt: { type: 'string' },
      changed: { type: 'string' },
      preserved: { type: 'array', items: { type: 'string' } },
      rationale: { type: 'string' },
    },
    required: ['new_prompt', 'changed', 'preserved', 'rationale'],
  };
}

export interface PatchSceneOptions {
  model?: string;
  effort?: ClaudeEffort;
}

export interface PatchSceneResult {
  project: Project;
  patch: ScenePatch;
}

/**
 * Apply a directed "change one thing, preserve everything else" edit to a scene's
 * prompt via the LLM, recording it in the scene's patch history. Embodies the
 * "locked by default" tenet: only the requested property changes.
 */
export async function patchScene(
  store: Store,
  claude: AnthropicLike,
  storylineId: string,
  sceneId: string,
  request: string,
  options: PatchSceneOptions = {},
): Promise<PatchSceneResult> {
  if (!request || !request.trim()) throw new UserInputError('Describe the change to make (e.g. "make Bobo look worried").');

  const project = store.getProject(storylineId);
  const scene = project.storyline.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new UserInputError(`Scene not found: ${sceneId}`);

  const canon = currentCanonVersion(store.getCanonRegistry(project.storyline.storyId));
  const user = [
    canon ? `# CANON (do not contradict locked marks)\n${buildCanonBlock(canon)}\n` : '',
    `# CURRENT SHOT`,
    `Heading: ${scene.heading}`,
    `Current prompt:\n${scene.prompt}`,
    `\n# REQUESTED CHANGE\n${request.trim()}`,
  ]
    .filter(Boolean)
    .join('\n');

  const { json, model } = await structuredCall(claude, {
    model: options.model ?? DEFAULT_DISSECT_MODEL,
    effort: options.effort ?? 'medium',
    system: PATCH_SYSTEM,
    user,
    schema: patchSchema(),
    maxTokens: 4000,
  });

  const raw = json as { new_prompt: string; changed: string; preserved: string[]; rationale: string };
  const newPrompt = (raw.new_prompt ?? '').trim();
  if (!newPrompt) throw new UserInputError('The patch produced an empty prompt.');

  // The revised prompt must still be a valid render prompt (length, etc.).
  const issues = collectValidationIssues(
    {
      prompt: newPrompt,
      model: scene.model,
      quality: scene.quality,
      duration: scene.duration,
      motionMode: scene.motionMode,
      aspectRatio: scene.aspectRatio,
      negativePrompt: scene.negativePrompt,
      style: scene.style,
      cameraMovement: scene.cameraMovement,
      imageId: scene.imageId,
    },
    { requireImage: typeof scene.imageId === 'number' },
  ).filter((i) => i.includes('prompt'));
  if (issues.length > 0) {
    throw Object.assign(new Error(`Patched prompt is invalid: ${issues.join(' ')}`), { issues });
  }

  const patch: ScenePatch = {
    id: makeId('patch'),
    request: request.trim(),
    before: scene.prompt,
    after: newPrompt,
    changed: raw.changed ?? '',
    preserved: raw.preserved ?? [],
    rationale: raw.rationale ?? '',
    model,
    createdAt: new Date().toISOString(),
  };

  scene.prompt = newPrompt;
  scene.patchHistory = [...(scene.patchHistory ?? []), patch];
  // A prompt change invalidates any existing render.
  project.clips[sceneId] = idleClip(sceneId);
  project.storyline.updatedAt = new Date().toISOString();
  store.saveProject(project);

  return { project, patch };
}
