import { structuredCall, type AnthropicLike } from '../clients/claude';
import type { ClaudeEffort } from '../constants';
import type { Store } from '../store/store';
import { makeId } from '../store/store';
import {
  buildCanonBlock,
  currentCanonVersion,
  DEFAULT_DISSECT_MODEL,
  patchMark,
} from './canon';
import type {
  CanonRegistry,
  DriftFinding,
  DriftReport,
  DriftResolutionAction,
  DriftSeverity,
  Project,
} from '../types';

function driftSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string' },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            entity_name: { type: 'string' },
            mark_key: { type: 'string' },
            expected: { type: 'string' },
            observed: { type: 'string' },
            scene_numbers: { type: 'array', items: { type: 'integer' } },
            severity: { type: 'string', enum: ['high', 'medium', 'low'] },
            explanation: { type: 'string' },
            suggestion: { type: 'string' },
          },
          required: [
            'entity_name',
            'mark_key',
            'expected',
            'observed',
            'scene_numbers',
            'severity',
            'explanation',
            'suggestion',
          ],
        },
      },
    },
    required: ['summary', 'findings'],
  };
}

const DRIFT_SYSTEM = `You are the continuity supervisor of an AI video production studio.
Compare a storyline's scene prompts against the canonical consistency marks and report every drift — any place where a scene contradicts, omits (when it matters), or alters a canonical fact.

Rules:
- LOCKED marks: any contradiction or unauthorized change is HIGH severity. A locked visual signature that is missing from a scene where the entity clearly appears is MEDIUM.
- STRONG marks: contradictions are MEDIUM, questionable variations LOW.
- FLEXIBLE marks: only report clearly jarring contradictions, as LOW.
- Marks labelled TRANSITIONING are mid-migration: scenes matching the new value are NOT drift; scenes matching only the old value are LOW severity ("still on old value").
- Audience/tone marks apply to the storyline as a whole (violence, fear, tone shifts...).
- "observed" quotes or paraphrases what the storyline actually says. "expected" is the canonical value.
- scene_numbers are the 1-based scene numbers involved (empty array for storyline-wide findings).
- Do not report style nitpicks that no viewer would notice; focus on real consistency breaks.
Return an empty findings array when the storyline is consistent.`;

export interface DriftCheckOptions {
  model?: string;
  effort?: ClaudeEffort;
}

interface RawFinding {
  entity_name: string;
  mark_key: string;
  expected: string;
  observed: string;
  scene_numbers: number[];
  severity: DriftSeverity;
  explanation: string;
  suggestion: string;
}

/** Run a consistency check of a storyline against the story's current canon. */
export async function checkDrift(
  store: Store,
  claude: AnthropicLike,
  storylineId: string,
  options: DriftCheckOptions = {},
): Promise<DriftReport> {
  const project = store.getProject(storylineId);
  const registry = store.getCanonRegistry(project.storyline.storyId);
  const canon = currentCanonVersion(registry);
  if (!registry || !canon) {
    throw new Error('No canon registry for this story — extract canon first.');
  }

  const scenes = [...project.storyline.scenes].sort((a, b) => a.order - b.order);
  const sceneBlock = scenes
    .map(
      (s, i) =>
        `## Scene ${i + 1}: ${s.heading}\nPrompt: ${s.prompt}\nNegative prompt: ${s.negativePrompt || '(none)'}`,
    )
    .join('\n\n');

  const user = [
    '# CANON',
    buildCanonBlock(canon),
    '\n# STORYLINE UNDER REVIEW',
    `Title: ${project.storyline.title}`,
    `Logline: ${project.storyline.logline}`,
    sceneBlock,
  ].join('\n');

  const { json, model } = await structuredCall(claude, {
    model: options.model ?? DEFAULT_DISSECT_MODEL,
    effort: options.effort ?? 'high',
    system: DRIFT_SYSTEM,
    user,
    schema: driftSchema(),
    maxTokens: 16000,
  });

  const raw = json as { summary: string; findings: RawFinding[] };

  const findings: DriftFinding[] = (raw.findings ?? []).map((f) => {
    const entity = canon.entities.find((e) => e.name.toLowerCase() === f.entity_name.toLowerCase());
    return {
      id: makeId('drift'),
      entityId: entity?.id ?? null,
      entityName: f.entity_name,
      markKey: f.mark_key,
      expected: f.expected,
      observed: f.observed,
      sceneIds: (f.scene_numbers ?? [])
        .map((n) => scenes[n - 1]?.id)
        .filter((id): id is string => Boolean(id)),
      severity: f.severity,
      explanation: f.explanation,
      suggestion: f.suggestion,
      resolution: null,
    };
  });

  const report: DriftReport = {
    id: makeId('rep'),
    storylineId,
    canonVersion: canon.version,
    model,
    createdAt: new Date().toISOString(),
    summary: raw.summary ?? '',
    findings,
  };

  project.driftReports = [...(project.driftReports ?? []), report];
  store.saveProject(project);
  return report;
}

function findFinding(project: Project, reportId: string, findingId: string): { report: DriftReport; finding: DriftFinding } {
  const report = (project.driftReports ?? []).find((r) => r.id === reportId);
  if (!report) throw new Error(`Drift report not found: ${reportId}`);
  const finding = report.findings.find((f) => f.id === findingId);
  if (!finding) throw new Error(`Drift finding not found: ${findingId}`);
  return { report, finding };
}

export interface ResolveDriftResult {
  report: DriftReport;
  finding: DriftFinding;
  registry: CanonRegistry | null;
}

/**
 * Resolve a drift finding:
 * - accept-now:        the observed value becomes canon immediately (new canon version).
 * - accept-gradually:  the mark enters a "transitioning" state; future storylines
 *                      blend from the old value toward the observed one.
 * - reject:            canon stands; the storyline scenes should be revised.
 */
export function resolveDrift(
  store: Store,
  storylineId: string,
  reportId: string,
  findingId: string,
  action: DriftResolutionAction,
  note = '',
): ResolveDriftResult {
  const project = store.getProject(storylineId);
  const { report, finding } = findFinding(project, reportId, findingId);
  if (finding.resolution) throw new Error('Finding is already resolved.');

  let registry: CanonRegistry | null = null;
  let canonVersion: number | null = null;

  if (action === 'accept-now' || action === 'accept-gradually') {
    if (!finding.entityId) {
      throw new Error('Cannot accept drift: the finding does not map to a canon entity.');
    }
    const storyId = project.storyline.storyId;
    const current = currentCanonVersion(store.getCanonRegistry(storyId));
    const entity = current?.entities.find((e) => e.id === finding.entityId);
    const hasMark = entity?.marks.some((m) => m.key === finding.markKey);

    if (!hasMark) {
      // The drift concerns a fact canon didn't track yet — add it as a mark first.
      registry = addMark(store, storyId, finding.entityId, finding.markKey, finding.expected || finding.observed, note);
    }
    if (action === 'accept-now') {
      registry = patchMark(store, storyId, finding.entityId, finding.markKey, {
        value: finding.observed,
        note: note || `Drift accepted from storyline ${storylineId}: ${finding.markKey}`,
      });
    } else {
      registry = patchMark(store, storyId, finding.entityId, finding.markKey, {
        status: 'transitioning',
        transitionTo: finding.observed,
        note: note || `Gradual acceptance from storyline ${storylineId}: ${finding.markKey}`,
      });
    }
    canonVersion = registry.currentVersion;
  }

  finding.resolution = {
    action,
    resolvedAt: new Date().toISOString(),
    note,
    canonVersion,
  };
  store.saveProject(project);
  return { report, finding, registry };
}

/** Add a brand-new mark to an entity (new canon version). */
function addMark(store: Store, storyId: string, entityId: string, key: string, value: string, note: string): CanonRegistry {
  const registry = store.getCanonRegistry(storyId);
  const current = currentCanonVersion(registry);
  if (!registry || !current) throw new Error('No canon registry.');
  const next = structuredClone(current);
  next.version = registry.currentVersion + 1;
  next.createdAt = new Date().toISOString();
  next.source = 'drift-acceptance';
  next.model = null;
  next.note = note || `Added mark ${key} while resolving drift`;
  const entity = next.entities.find((e) => e.id === entityId);
  if (!entity) throw new Error(`Canon entity not found: ${entityId}`);
  entity.marks.push({
    key,
    value,
    severity: 'strong',
    status: 'active',
    transition: null,
    rationale: 'Added during drift resolution.',
  });
  registry.versions.push(next);
  registry.currentVersion = next.version;
  store.saveCanonRegistry(registry);
  return registry;
}
