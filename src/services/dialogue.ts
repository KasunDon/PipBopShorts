import { structuredCall, type AnthropicLike } from '../clients/claude';
import type { ClaudeEffort } from '../constants';
import { buildCanonBlock, currentCanonVersion, DEFAULT_DISSECT_MODEL } from './canon';
import { isChildAudience } from './drift';
import type { Store } from '../store/store';

const DIALOGUE_SYSTEM = `You are the dialogue and caption writer for short-form video.
For each scene, write an optional short line of dialogue (only where it serves the moment) and a punchy on-screen caption that reads well with the sound off.
Keep every line in character and consistent with canon. Match the declared tone and audience.
CHILD-AUDIENCE MODE (when flagged): keep lines very short and simple, kind, and easy to read — no scary or complex language.`;

function dialogueSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      scenes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            scene_number: { type: 'integer' },
            caption: { type: 'string' },
            lines: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  speaker: { type: 'string' },
                  text: { type: 'string' },
                },
                required: ['speaker', 'text'],
              },
            },
          },
          required: ['scene_number', 'caption', 'lines'],
        },
      },
    },
    required: ['scenes'],
  };
}

export interface SceneDialogue {
  sceneId: string;
  sceneNumber: number;
  heading: string;
  caption: string;
  lines: Array<{ speaker: string; text: string }>;
}

export interface DialogueOptions {
  model?: string;
  effort?: ClaudeEffort;
}

/** Plan per-scene dialogue lines + sound-off captions for a storyline, grounded in canon + audience. */
export async function planStorylineDialogue(
  store: Store,
  claude: AnthropicLike,
  storylineId: string,
  options: DialogueOptions = {},
): Promise<SceneDialogue[]> {
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
    '\n# TASK\nWrite the caption (and any dialogue) for each scene.',
  ]
    .filter(Boolean)
    .join('\n');

  const { json } = await structuredCall(claude, {
    model: options.model ?? DEFAULT_DISSECT_MODEL,
    effort: options.effort ?? 'medium',
    system: DIALOGUE_SYSTEM,
    user,
    schema: dialogueSchema(),
    maxTokens: 8000,
  });

  const raw = (json as { scenes?: Array<{ scene_number: number; caption: string; lines: Array<{ speaker: string; text: string }> }> }).scenes ?? [];
  const result = raw
    .map((entry) => {
      const scene = scenes[entry.scene_number - 1];
      if (!scene) return null;
      return {
        sceneId: scene.id,
        sceneNumber: entry.scene_number,
        heading: scene.heading,
        caption: entry.caption ?? '',
        lines: entry.lines ?? [],
      };
    })
    .filter((x): x is SceneDialogue => x !== null);

  // Persist captions onto the scenes so they drive the subtitle (.srt) track and
  // stay editable.
  let changed = false;
  for (const entry of result) {
    const scene = project.storyline.scenes.find((s) => s.id === entry.sceneId);
    if (scene && entry.caption && scene.caption !== entry.caption) {
      scene.caption = entry.caption;
      changed = true;
    }
  }
  if (changed) store.saveProject(project);

  return result;
}
