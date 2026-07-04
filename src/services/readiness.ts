import type { Store } from '../store/store';
import { referenceReadiness } from './characters';
import { validateStorylineForRender } from './preview';

export interface ReadinessCheck {
  label: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}
export interface ProductionReadiness {
  checks: ReadinessCheck[];
  /** True when there are no failing checks (warnings are allowed). */
  ready: boolean;
}

/**
 * A single "are we ready to ship?" checklist for a storyline, composing the
 * gates built across the pipeline: scene validation, reference approval, render +
 * clip approval, unresolved high-severity drift, and publish metadata.
 * Deterministic — no LLM or network.
 */
export function productionReadiness(store: Store, storylineId: string): ProductionReadiness {
  const project = store.getProject(storylineId);
  const scenes = project.storyline.scenes;
  const checks: ReadinessCheck[] = [];

  // 1. Scene parameter validation.
  const validation = validateStorylineForRender(store, storylineId);
  checks.push({
    label: 'Scene parameters valid',
    status: validation.ok ? 'ok' : 'fail',
    detail: validation.ok ? `All ${scenes.length} scenes pass.` : `${validation.invalidCount} scene(s) have issues.`,
  });

  // 2. Reference approval.
  const refs = referenceReadiness(store, storylineId);
  checks.push({
    label: 'References approved',
    status: refs.items.length === 0 ? 'ok' : refs.ready ? 'ok' : 'warn',
    detail:
      refs.items.length === 0
        ? 'No character/location references used.'
        : refs.ready
          ? `${refs.items.length} reference(s) approved.`
          : `${refs.unapproved.length} of ${refs.items.length} not approved.`,
  });

  // 3. Clips rendered + approved.
  const ready = scenes.filter((s) => project.clips[s.id]?.status === 'ready').length;
  const approved = scenes.filter((s) => project.clips[s.id]?.approved).length;
  const allApproved = scenes.length > 0 && approved === scenes.length;
  checks.push({
    label: 'Clips rendered & approved',
    status: allApproved ? 'ok' : ready === 0 ? 'fail' : 'warn',
    detail: `${ready}/${scenes.length} rendered · ${approved} approved.`,
  });

  // 4. Unresolved high-severity drift (from the latest report).
  const latest = (project.driftReports ?? [])[(project.driftReports ?? []).length - 1];
  const openHigh = latest ? latest.findings.filter((f) => f.severity === 'high' && !f.resolution).length : 0;
  checks.push({
    label: 'Consistency & safety',
    status: !latest ? 'warn' : openHigh > 0 ? 'fail' : 'ok',
    detail: !latest
      ? 'No consistency check run yet.'
      : openHigh > 0
        ? `${openHigh} unresolved high-severity finding(s).`
        : 'No unresolved high-severity findings.',
  });

  // 5. Publish metadata.
  const hasTitle = Boolean(project.storyline.youtube.title.trim());
  checks.push({
    label: 'Publish metadata',
    status: hasTitle ? 'ok' : 'warn',
    detail: hasTitle ? 'Title set.' : 'No YouTube title yet.',
  });

  return { checks, ready: !checks.some((c) => c.status === 'fail') };
}
