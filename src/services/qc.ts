import { structuredCall, type AnthropicLike } from '../clients/claude';
import type { ClaudeEffort } from '../constants';
import { UserInputError } from '../errors';
import type { Store } from '../store/store';
import type { CanonEntity } from '../types';
import { currentCanonVersion } from './canon';
import { entityBase } from './characters';

const QC_SYSTEM = `You are the quality-control supervisor verifying a single shot's prompt against the canon it must honour.
For each canon mark provided, decide whether the shot's prompt satisfies it:
- "pass": the prompt clearly honours the mark (or the mark plainly doesn't apply to this shot).
- "warn": the mark applies and the prompt is silent/ambiguous about it (a locked visual signature that should be present but isn't described).
- "fail": the prompt contradicts the mark.
Give a one-line note for anything that isn't a clean pass. Judge only what the prompt says; do not invent problems.`;

function qcSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      checks: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            entity_name: { type: 'string' },
            mark_key: { type: 'string' },
            verdict: { type: 'string', enum: ['pass', 'warn', 'fail'] },
            note: { type: 'string' },
          },
          required: ['entity_name', 'mark_key', 'verdict', 'note'],
        },
      },
    },
    required: ['checks'],
  };
}

export interface QcCheck {
  entityName: string;
  markKey: string;
  expected: string;
  verdict: 'pass' | 'warn' | 'fail';
  note: string;
}
export interface QcResult {
  sceneId: string;
  checks: QcCheck[];
  passed: number;
  warnings: number;
  failures: number;
}

export interface QcOptions {
  model?: string;
  effort?: ClaudeEffort;
}

/**
 * Prompt-level continuity QC for one scene: verify the scene's prompt against the
 * canon marks of the entities it references, plus always-on visual-style and
 * audience/tone marks. (A pixel-level vision QC on the rendered frame is a future
 * step once image inputs are available.)
 */
export async function qcScene(
  store: Store,
  claude: AnthropicLike,
  storylineId: string,
  sceneId: string,
  options: QcOptions = {},
): Promise<QcResult> {
  const project = store.getProject(storylineId);
  const scene = project.storyline.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new UserInputError(`Scene not found: ${sceneId}`);
  const canon = currentCanonVersion(store.getCanonRegistry(project.storyline.storyId));
  if (!canon) throw new UserInputError('No canon to check against — extract canon first.');

  const referenced = new Set((scene.referenceCharacterIds ?? []).map(entityBase));
  const relevant: CanonEntity[] = canon.entities.filter(
    (e) => referenced.has(entityBase(e.id)) || e.type === 'visual_style' || e.type === 'audience_tone',
  );
  const markLines = relevant.flatMap((e) =>
    e.marks.map((m) => `- [${e.name}] ${m.key} (${m.severity}): ${m.value}`),
  );
  if (markLines.length === 0) {
    return { sceneId, checks: [], passed: 0, warnings: 0, failures: 0 };
  }

  const user = [
    `# SHOT PROMPT`,
    scene.prompt,
    `\n# CANON MARKS TO VERIFY`,
    ...markLines,
  ].join('\n');

  const { json } = await structuredCall(claude, {
    model: options.model ?? 'claude-sonnet-5',
    effort: options.effort ?? 'low',
    system: QC_SYSTEM,
    user,
    schema: qcSchema(),
    maxTokens: 4000,
  });

  const raw = (json as { checks?: Array<{ entity_name: string; mark_key: string; verdict: 'pass' | 'warn' | 'fail'; note: string }> }).checks ?? [];
  const checks: QcCheck[] = raw.map((c) => {
    const entity = relevant.find((e) => e.name.toLowerCase() === c.entity_name.toLowerCase());
    const mark = entity?.marks.find((m) => m.key === c.mark_key);
    return {
      entityName: c.entity_name,
      markKey: c.mark_key,
      expected: mark?.value ?? '',
      verdict: c.verdict,
      note: c.note,
    };
  });

  return {
    sceneId,
    checks,
    passed: checks.filter((c) => c.verdict === 'pass').length,
    warnings: checks.filter((c) => c.verdict === 'warn').length,
    failures: checks.filter((c) => c.verdict === 'fail').length,
  };
}
