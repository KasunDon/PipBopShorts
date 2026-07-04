import type { Store } from '../store/store';
import { currentCanonVersion } from './canon';
import { resolveSceneReferences } from './characters';

/**
 * A per-scene shot manifest (markdown) — the reproducible production document for
 * a storyline: every scene's render parameters, references, prompt, directed
 * edits, review notes, and current clip status. Deterministic (no LLM), for
 * handoff, review, and re-rendering exactly.
 */
export function buildShotManifest(store: Store, storylineId: string): string {
  const project = store.getProject(storylineId);
  const storyId = project.storyline.storyId;
  const canon = currentCanonVersion(store.getCanonRegistry(storyId));
  const scenes = [...project.storyline.scenes].sort((a, b) => a.order - b.order);
  const totalDuration = scenes.reduce((n, s) => n + (Number(s.duration) || 0), 0);

  const lines: string[] = [];
  lines.push(`# Shot Manifest — ${project.storyline.title}`);
  if (project.storyline.logline) lines.push(`\n_${project.storyline.logline}_`);
  lines.push(
    `\nCanon v${canon?.version ?? '—'} · ${scenes.length} scenes · ${totalDuration}s total · generated ${new Date().toISOString()}`,
  );

  scenes.forEach((scene, i) => {
    const clip = project.clips[scene.id];
    const status = clip?.approved ? 'approved' : (clip?.status ?? 'idle');
    const refs = resolveSceneReferences(store, storyId, scene.referenceCharacterIds ?? []);
    lines.push(`\n## Scene ${i + 1}: ${scene.heading}  \`${status}\``);
    lines.push(
      `- **Render**: ${scene.duration}s · ${scene.aspectRatio} · ${scene.model} · ${scene.quality} · motion ${scene.motionMode} · style ${scene.style} · camera ${scene.cameraMovement}`,
    );
    if (scene.referenceCharacterIds?.length) {
      const names = refs.descriptors.map((d) => d.name);
      lines.push(`- **References**: ${names.length ? names.join(', ') : scene.referenceCharacterIds.join(', ')}${refs.imageId != null ? ' (image-to-video)' : ''}`);
    }
    if (scene.description) lines.push(`- **Intent**: ${scene.description}`);
    lines.push(`- **Prompt**: ${scene.prompt}`);
    if (scene.negativePrompt) lines.push(`- **Negative**: ${scene.negativePrompt}`);
    if (clip?.url) lines.push(`- **Clip**: ${clip.url}`);
    if (scene.patchHistory?.length) {
      lines.push(`- **Directed edits**:`);
      for (const p of scene.patchHistory) lines.push(`  - “${p.request}” → ${p.changed}`);
    }
    const openNotes = (scene.comments ?? []).filter((c) => !c.resolved);
    if (openNotes.length) {
      lines.push(`- **Open notes**:`);
      for (const c of openNotes) lines.push(`  - ${c.text}`);
    }
  });

  return lines.join('\n') + '\n';
}
