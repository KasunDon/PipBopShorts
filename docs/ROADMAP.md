# PipBopShorts — AI Film Production Studio Roadmap

This roadmap folds the *AI Film Studio Agent Handover Spec* and the *PipBop Story & Series
Bible* into the platform, broken into deliverable phases. The guiding principle from the
spec applies everywhere:

> **Treat every approved output as an existing film set.** When the director requests one
> small change, change only that property and preserve everything else.

The platform is a **studio**: multiple IPs (stories), each with version-controlled canon,
repeatable AI workflows, and human approval at every creative gate. First IP: kids'
content — so emotional safety and consistency are product features, not afterthoughts.

---

## ✅ Phase 0 — Core pipeline (shipped)

Story → episode → Claude storyline (model + effort picker) → PixVerse render →
preview/tweak/extend → YouTube Shorts publish (dry-run capable). Regression suite with all
externals mocked.

## ✅ Phase 1 — Canon & consistency foundation (shipped)

The "continuity supervisor" layer:

- **Canonical `.md` templates** (story bible, episode setting) — generic structure that
  captures premise, audience & tone, world rules, character *visual signatures* with
  explicit **"never change"** lists, relationships, locations, story formula, safety
  rails, and ready-to-paste consistency prompts.
- **Story production metadata** — audience age range, genres, tones, format, episode
  length — steering every storyline and auto-generating audience/tone consistency marks.
- **Canon extraction** — an LLM (default **Sonnet 5**, selectable Opus 4.8 / Fable 5)
  dissects the bible into a **version-controlled canon registry**: characters,
  relationships, locations, props, world rules, visual style, audience/tone. Every fact is
  a *consistency mark* with severity `locked` / `strong` / `flexible` and stable asset IDs
  (`CHAR_BOBO_001`-style).
- **Drift detection** — any storyline can be checked against canon; findings carry
  severity, the exact scenes involved, and a suggestion.
- **Drift resolution** — per finding: **reject** (canon stands), **accept now** (new canon
  version), or **accept gradually** (the mark enters a `transitioning` state; future
  storylines are instructed to blend from the old value toward the new one until the
  transition is completed).
- Canon block + global negative prompt injected into all storyline generation; child-
  safety directives activate automatically when the audience is ≤ 12.

## ✅ Phase 2a — Character reference images (shipped)

Consistency by reference, not just by prompt:

- Versioned **character reference registry** synced from canon characters.
- Generate a PixVerse **portrait** per character from a canon-built prompt; **refresh**
  and **tweak-prompt** on demand — every attempt is an immutable version, with an
  **approved** pointer.
- Approved reference is **sent to PixVerse** at scene render time (image-to-video via an
  uploaded `img_id`; first-frame auto-extraction when ffmpeg is present, plus direct
  still upload), with approved descriptors injected into the prompt.
- Scenes **auto-link** to the characters named in them; the whole registry is
  version-controlled and rides along in `.story.md` export/import.

## ✅ Phase 2a.1 — Production ergonomics & auditability (shipped this iteration)

- **Async background renders** — clips/portraits submit-and-forget; a server-side
  JobRunner polls PixVerse to completion (survives tab close + server restart),
  with SSE notifications, de-dupe, and button disables while in flight.
- **LLM auto-fix of render-parameter issues** — one button repairs every invalid
  scene using full story + canon context and each scene's creative intent (keeps
  the fast-motion "wow" by shortening to 5s vs. dropping motion), never touching
  the prompt; deterministic fallback guarantees resolution.
- **Tone & child-safety consistency** — drift checks now audit tone + audience
  metadata (findings carry a `consistency | safety` category); a strict
  CHILD-SAFETY mode auto-activates for audiences ≤ 12.
- **Storyline-generation feedback** — elapsed readout + cancel + "working behind
  the scenes" state (the long LLM call no longer looks hung / "failed to fetch";
  dev-proxy and server request timeouts removed for long calls).
- **Scenes auto-reference characters AND locations** named in them; each scene
  lists its references with an approved / not-approved indicator for review.
- **Pre-render approval gate** — before "Render all", any referenced
  character/location without an approved reference image is surfaced in a modal
  with a thumbnail; approve (or generate-&-approve) inline, or "generate anyway".
- **Global scene settings** — set an aspect ratio once and apply it to every
  scene (skips scenes it would make invalid); endpoint already accepts
  quality/model/motion/style for future controls.
- **Mutation audit trail** — deletes and edits (story/episode/storyline/scene,
  YouTube meta, canon marks, bulk defaults) record a `store` audit event with the
  **old value preserved** for accountability and fail-safe.

### Also shipped (follow-up)

- **Restore-from-audit (fail-safe)** — deleted storylines and scenes can be
  rehydrated one-click from the old value preserved in their `store` audit event
  (Activity console → expand a `*.delete` event → **Restore**). Guards against
  clobbering an existing record or orphaning under a deleted parent.
- **Global settings widened in the UI** — aspect ratio **+ quality + motion mode**
  now apply to every scene at once (the endpoint still also accepts model/style).
- **Mutation audit widened** — add-scene, reorder (old order preserved),
  approve-portrait (old approval preserved), and publish now record `store` events.
- **Inline tweak-then-approve in the approval gate** — each unapproved reference
  can be opened inline to edit its prompt + params, generate a preview, and
  approve that preview, all without leaving the render flow.
- **Cascade-aware restore for story & episode deletions** — deletes now snapshot
  the whole subtree (bible, canon, characters, episodes, settings, storylines) so
  a deleted story or episode restores losslessly, not just storylines/scenes.
- **All global settings exposed** — aspect ratio, quality, motion, **model, and
  style** now have apply-to-all-scenes controls.

### Outstanding (captured — tackle next)

- **Dedicated audit view/filter** beyond the shared activity console (e.g. a
  data-mutation-only timeline with diff highlighting of before→after).
- **Image-to-video aspect ratio**: img-to-video derives aspect from the source
  image, so the global aspect ratio only affects text-to-video scenes today —
  decide whether to letterbox/crop references to enforce a uniform aspect.
- **Approval gate policy**: make the gate a configurable warn-vs-block, and allow
  multi-image references once the model supports more than one `img_id`.

## 🔜 Phase 2b — Location/prop references & scene patching (next)

- **Reference library for locations & props** (same pattern as characters): approved
  stills attached to canon entities and injected into the relevant scenes.
- Multi-reference scenes: send more than one approved image when the model supports it.
- ~~**Scene patch requests**~~ — **shipped**: a directed edit ("make the hero look
  worried, change nothing else") rewrites only the requested property via the LLM,
  preserving everything else and honouring locked canon marks; each edit records
  before/after + what changed + what was preserved as per-scene patch history
  (`POST /scenes/:id/patch`, inline control on each scene card).
- **Approval workflow** — *partly shipped*: each rendered clip carries a human
  **approved** sign-off (reset on any edit/re-render), **publishing is gated** on
  every rendered clip being approved, and the console shows an approved count +
  per-clip Approve control. Still to do: the richer `draft → candidate →
  canonical` states, and making approved clips reusable as references for future
  scenes.
- **Continuity QC checklist** auto-run on rendered clips (LLM vision pass against canon
  marks: accessory present? colors right? style consistent?).
- ~~**Canon diff view** in the UI~~ — **shipped**: the canon panel shows a
  changelog between any version and the prior one (entities added/removed and
  per-mark value/severity/status changes), backed by `GET /canon/diff`.

## Phase 3 — Episode production depth

- **Beat sheets & shot manifests**: storyline → beat sheet → per-scene manifest (camera
  preset, lighting preset, locked properties, allowed variation) as the unit the renderer
  consumes; seeds and generation params recorded per attempt for reproducibility.
- **Audio & subtitles** *(requested — not built yet)*: the current pipeline renders silent
  video only. Planned:
  - **Background music**: per-episode music bed (mood/tempo from the bible's tone marks),
    a music library or generative-audio provider behind the same cost framework as video,
    with ducking under narration.
  - **Voiceover / narration & dialogue TTS**: per-scene dialogue lines (already planned
    below) rendered to speech with per-character voices, timed to each clip.
  - **Sound effects**: per-scene SFX cues from the bible's character sound motifs.
  - **Subtitles / captions**: auto-generated, styled, burned-in or sidecar `.srt`; required
    for Shorts watch-with-sound-off. Multi-language captions tie into Phase 5 localization.
  - **Mix & mux**: assemble music + VO + SFX + captions onto the stitched video (ffmpeg),
    with a loudness target and safe-area caption placement.
- **Dialogue & sound planning**: dialogue lines per scene (kid-appropriate line-length
  rules), sound-effect and music cue notes, character sound motifs from the bible.
- **Assembly**: server-side stitch with transitions, title/end cards, safe-area checks for
  Shorts; per-scene retry queue with cost tracking.
- ~~**Series planning**: episode idea backlog~~ — **shipped**: "Suggest ideas"
  brainstorms distinct future-episode concepts (title + hook + synopsis) grounded
  in the bible, canon, tone/audience, and existing episodes (no repeats); each
  idea has a one-click **Develop** into the episode drafter. Still to do:
  persisting the backlog and richer "develop → full brief" automation.

## Phase 4 — Studio scale

- **Multi-IP dashboards** — *per-story analytics shipped*: an Insights tab shows
  episodes/storylines/scenes, clips ready/approved, publishes, canon stability
  (versions/entities/marks/locked), and drift health (open vs resolved, safety,
  drift rate). Still to do: the cross-IP roll-up dashboard, trend charts over
  time, and shared style presets.
- **Longer formats**: 3-act structure support (primary thread + friendship thread + comedy
  runner), scene-count scaling, per-act drift checks.
- **Season arcs**: season-level canon (what may evolve across a season vs. never),
  scheduled production runs.
- **Team workflow**: review/approve roles, comments on scenes, audit log of canon changes.

## Phase 5 — Distribution intelligence

- Publish scheduling, A/B titles/thumbnails, retention analytics fed back into the story
  formula, localization (dubbed/translated variants with canon-consistent visuals).

---

## Design tenets (all phases)

1. **AI is crew, not director** — every canon change, drift acceptance, and publish is a
   human decision surfaced in the UI.
2. **Version everything that defines the IP** — canon versions are append-only history;
   nothing is silently rewritten.
3. **Locked by default** — unlisted properties are preserved; only explicitly requested
   changes are allowed (drives the Phase 2 patch flow).
4. **Kid-safe by construction** — audience metadata activates hard safety rails in
   prompts, negative prompts, and QC; safety marks are always `locked`.
5. **Generic engine, specific IPs** — templates and canon schema stay IP-agnostic; PipBop
   is the first tenant, not a special case.
