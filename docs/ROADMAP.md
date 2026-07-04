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

- **Dedicated audit view/filter** — *partly done*: the activity console filters
  the `store` service and now renders a readable before→after field diff for each
  mutation. Still to do: a standalone data-mutation-only timeline separate from
  the network-call log.
- **Image-to-video aspect ratio**: img-to-video derives aspect from the source
  image, so the global aspect ratio only affects text-to-video scenes today —
  decide whether to letterbox/crop references to enforce a uniform aspect.
- **Approval gate policy**: make the gate a configurable warn-vs-block, and allow
  multi-image references once the model supports more than one `img_id`.

## 🔜 Phase 2b — Location/prop references & scene patching (next)

- **Reference library for locations & props** (same pattern as characters): approved
  stills attached to canon entities and injected into the relevant scenes.
- Multi-reference scenes: *partly shipped* — a scene injects descriptors for every
  referenced character/location into the prompt, and you can **choose which
  reference's approved image seeds** the image-to-video (click a reference chip).
  Still to do: sending more than one image once PixVerse supports multiple `img_id`s.
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
- **Continuity QC checklist** — *prompt-level QC shipped*: per-scene, verify the
  prompt against the canon marks it references (+ always-on visual-style /
  audience marks) with pass/warn/fail verdicts and notes. Still to do: the
  pixel-level **vision** pass on the rendered frame (needs image inputs to the
  gateway).
- ~~**Canon diff view** in the UI~~ — **shipped**: the canon panel shows a
  changelog between any version and the prior one (entities added/removed and
  per-mark value/severity/status changes), backed by `GET /canon/diff`.

## Phase 3 — Episode production depth

- **Beat sheets & shot manifests**: *beat sheets shipped* — generate a structural
  beat sheet (hook → complication → turn → climax → resolution) for an episode,
  grounded in bible/brief/setting + canon, one-click foldable into the storyline
  guidance. A downloadable **per-scene shot manifest** (every scene's render
  params, references, prompt, directed edits, open notes, clip status) is also
  shipped as the reproducible production document. Still to do: camera/lighting
  *presets* as first-class manifest fields and per-attempt seeds for exact repro.
- **Audio & subtitles** *(requested — not built yet)*: the current pipeline renders silent
  video only. Planned:
  - **Background music**: per-episode music bed (mood/tempo from the bible's tone marks),
    a music library or generative-audio provider behind the same cost framework as video,
    with ducking under narration.
  - **Voiceover / narration & dialogue TTS**: per-scene dialogue lines (already planned
    below) rendered to speech with per-character voices, timed to each clip.
  - **Sound effects**: per-scene SFX cues from the bible's character sound motifs.
  - **Subtitles / captions**: *sidecar `.srt` + burned-in captions shipped* —
    dialogue planning persists each scene's caption; a downloadable `.srt` is built
    timed to the scene durations, and on a stitched publish the captions are burned
    into the video via ffmpeg's `subtitles` filter (bundled ffmpeg supports it).
    Still to do: caption styling and multi-language caption variants.
  - **Mix & mux**: assemble music + VO + SFX + captions onto the stitched video (ffmpeg),
    with a loudness target and safe-area caption placement.
- ~~**Dialogue & sound planning**~~ — **shipped**: per-scene sound-off captions +
  optional in-character dialogue lines, AND an overall music direction with
  per-scene SFX cues and character sound motifs — all canon-grounded with a
  child-audience mode. (Actual TTS/music generation + mux remains under Audio &
  subtitles above.)
- **Assembly**: *stitch + crossfade transitions + burned captions shipped* —
  server-side concat with optional xfade crossfades and burned-in `.srt` captions
  (bold, outlined, bottom safe-area placement via libass `force_style`) on publish.
  A **Shorts-format (9:16) safe-area check** is in the readiness checklist. Still
  to do: title/end cards (bundled ffmpeg lacks `drawtext`, so this needs a
  text-capable ffmpeg or an image-composited card) and a per-scene retry queue
  with cost tracking.
- ~~**Series planning**: episode idea backlog~~ — **shipped**: "Suggest ideas"
  brainstorms distinct future-episode concepts (title + hook + synopsis) grounded
  in the bible, canon, tone/audience, and existing episodes (no repeats); each
  idea has a one-click **Develop** into the episode drafter. Still to do:
  persisting the backlog and richer "develop → full brief" automation.

## Phase 4 — Studio scale

- **Multi-IP dashboards** — *shipped*: a per-story Insights tab (volume, clips
  ready/approved, publishes, canon stability, drift health) **and** a studio-wide
  overview on the home screen that rolls up every story and surfaces the riskiest
  (safety findings / open drifts) first with jump-to links. **Shared cross-IP
  style presets** are also shipped — save a named set of render defaults once and
  load/apply it to any storyline's scenes. Still to do: trend charts over time.
- **Longer formats**: *three-act structure + scene-count scaling shipped* — a
  Structure picker on storyline generation injects a compact three-act arc
  directive (setup → escalation/turn → climax/resolution). Still to do: parallel
  threads (friendship/comedy runner) and per-act drift checks.
- **Season arcs**: *season-level canon shipped* — a "Season canon" view splits the
  canon into what must **never change** (the locked spine) vs what **may evolve**
  (strong/flexible). *Scheduled production runs shipped* — queue a full storyline
  render for a future time; the server-side scheduler fires it into the JobRunner
  (survives restart).
- **Team workflow**: ~~review/approve~~ (**shipped** — a storyline-level editorial
  review status (draft → in-review → approved / changes-requested) that feeds the
  readiness checklist, distinct from per-clip technical approval), ~~comments on
  scenes~~ (**shipped** — per-scene review notes with resolve/delete), audit log of
  canon changes (**shipped** — versioned + `store`-audited). Still to do:
  multi-user identity/roles behind real auth.

## Phase 5 — Distribution intelligence

- *Localization (metadata) + A/B title options shipped* — one-click translate a
  Short's title/description/tags/hashtags into any language, and generate A/B
  title options (each with its marketing angle) to pick from, both previewed in
  the metadata editor. **Publish scheduling** is also shipped — queue a publish
  for a future time; a server-side scheduler fires it (approval-gated, survives
  restart). **A/B thumbnail concepts** are also shipped — overlay text + framing +
  which scene to freeze, per concept. **Performance recording** is also shipped —
  log real views/retention/likes per short; views roll up into the per-story and
  studio analytics. A **season-wide canon changelog** (every version's diff from
  the prior one) gives the audit-log-of-canon-changes view. **Performance →
  story-formula insights** is also shipped — an LLM analyses recorded performance
  across a story's shorts for what's working and recommends a formula tweak. The
  **analytics-sync pipeline** is built + tested behind a pluggable source, and the
  **live YouTube Analytics fetch** is implemented (parses views/likes/retention;
  no-ops in dry-run) — it activates with credentials + the `yt-analytics.readonly`
  scope, exactly like the live publish path. Still open: rendering the actual
  thumbnail images, and dubbed/translated video variants with canon-consistent visuals.

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
