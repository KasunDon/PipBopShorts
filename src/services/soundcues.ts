import { structuredCall, type AnthropicLike } from '../clients/claude';
import type { ClaudeEffort } from '../constants';
import { buildCanonBlock, currentCanonVersion, DEFAULT_DISSECT_MODEL } from './canon';
import { isChildAudience } from './drift';
import type { Store } from '../store/store';

const SOUND_SYSTEM = `You are a sound designer planning music and effects for a short.
Suggest one overall music direction (mood, tempo, instrumentation) for the whole short, then per scene list a few concrete sound-effect cues tied to the on-screen action, plus each recurring character's signature sound motif where relevant.
Match the declared tone and audience. CHILD-AUDIENCE MODE (when flagged): keep everything gentle, playful, and non-scary — soft, bouncy, reassuring sounds.`;

function soundSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      music: { type: 'string' },
      scenes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            scene_number: { type: 'integer' },
            sfx: { type: 'array', items: { type: 'string' } },
            motif: { type: 'string' },
          },
          required: ['scene_number', 'sfx', 'motif'],
        },
      },
    },
    required: ['music', 'scenes'],
  };
}

export interface SceneSound {
  sceneId: string;
  sceneNumber: number;
  heading: string;
  sfx: string[];
  motif: string;
}
export interface SoundPlan {
  music: string;
  scenes: SceneSound[];
}

export interface SoundPlanOptions {
  model?: string;
  effort?: ClaudeEffort;
}

/** Plan a music direction + per-scene SFX cues and character sound motifs for a storyline. */
export async function planStorylineSound(
  store: Store,
  claude: AnthropicLike,
  storylineId: string,
  options: SoundPlanOptions = {},
): Promise<SoundPlan> {
  const project = store.getProject(storylineId);
  const story = store.getStory(project.storyline.storyId);
  const canon = currentCanonVersion(store.getCanonRegistry(story.id));
  const childAudience = isChildAudience(story.meta);
  const scenes = [...project.storyline.scenes].sort((a, b) => a.order - b.order);

  const user = [
    `# STORY: ${story.title}`,
    story.meta.tones.length ? `Tone: ${story.meta.tones.join(', ')}` : '',
    childAudience ? '\n*** CHILD-AUDIENCE MODE: ON ***' : '',
    canon ? `\n# CANON\n${buildCanonBlock(canon)}` : '',
    '\n# SCENES',
    ...scenes.map((s, i) => `## Scene ${i + 1}: ${s.heading}\n${s.prompt}`),
    '\n# TASK\nGive the overall music direction and per-scene sound cues.',
  ]
    .filter(Boolean)
    .join('\n');

  const { json } = await structuredCall(claude, {
    model: options.model ?? DEFAULT_DISSECT_MODEL,
    effort: options.effort ?? 'medium',
    system: SOUND_SYSTEM,
    user,
    schema: soundSchema(),
    maxTokens: 6000,
  });

  const raw = json as { music?: string; scenes?: Array<{ scene_number: number; sfx: string[]; motif: string }> };
  const sceneCues = (raw.scenes ?? [])
    .map((entry) => {
      const scene = scenes[entry.scene_number - 1];
      if (!scene) return null;
      return {
        sceneId: scene.id,
        sceneNumber: entry.scene_number,
        heading: scene.heading,
        sfx: entry.sfx ?? [],
        motif: entry.motif ?? '',
      };
    })
    .filter((x): x is SceneSound => x !== null);

  return { music: raw.music ?? '', scenes: sceneCues };
}
