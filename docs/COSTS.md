# Cost accounting & PixVerse cost-saving

Every paid operation in the studio — LLM calls (Claude, via the gateway) and
PixVerse renders/uploads — is captured in the local **audit log** and priced
through a provider-agnostic cost framework. You can see spend live in the
console (**💰 Costs** and **🛰 Events** in the top bar) and query it over HTTP.

## The framework

- [`src/costs/pricing.ts`](../src/costs/pricing.ts) — the single place pricing lives.
  - **LLM**: Anthropic list prices (USD / 1M tokens). Cache read ≈ 0.1× input, write ≈ 1.25× input.
  - **Media providers**: a `MediaProvider` registry. PixVerse ships in the box; add
    Runway / Kling / Luma / … by registering another provider — nothing else changes.
- [`src/costs/costFromEvent.ts`](../src/costs/costFromEvent.ts) — turns a captured
  network call into a normalized `CostEstimate`. For Claude it uses the **gateway's
  reported exact cost** (`totalCostUsd`) and captures token usage; for PixVerse it
  prices from the request's model/quality/duration.
- [`src/costs/context.ts`](../src/costs/context.ts) — an `AsyncLocalStorage` that
  attributes each call to a story / episode / scene / phase, so costs roll up per
  production unit for analytics.
- [`src/costs/report.ts`](../src/costs/report.ts) + `GET /api/costs/report` — aggregate
  totals by provider, kind, model, phase, and story, plus token totals.

### Configuring PixVerse pricing

PixVerse bills in **credits**, and per-render credit costs vary by plan. The
defaults in `PIXVERSE_CREDIT_TABLE` and the credit→USD rate are **estimates** —
tune them to your account:

- Set the USD-per-credit rate with `PIXVERSE_CREDIT_USD` (default `0.012`).
- Adjust the per-quality / per-duration credit table in `src/costs/pricing.ts`.

Claude figures are exact (reported by the gateway); PixVerse figures are marked
as estimates in the report (`hasEstimates`).

## Preview & validate before you spend

- **Preview the AI context** before generating a storyline: `GET /api/episodes/:id/storyline-preview`
  returns the exact bible + brief + setting + canon the AI will receive, plus
  pre-flight checks (missing bible, empty brief, no canon). Surfaced as
  **👁 Preview AI context** on the episode screen — review before spending an LLM call.
- **Validate + estimate render cost** before committing PixVerse credits:
  `GET /api/storylines/:id/validate` checks every scene against PixVerse's
  parameter rules and returns a per-scene + total credit/USD estimate. Surfaced
  as **🧮 Validate & estimate cost** on the storyline screen.

## Making edits without wasting credits

Patterns the app already supports, plus PixVerse features worth adopting:

| Technique | How it saves credits |
| --- | --- |
| **Only changed scenes re-render** | Editing a scene resets *only that scene's* clip (`updateScene`), so a tweak never re-renders the whole storyline. |
| **Draft low, finalize high** | Iterate at `360p`/`540p` (cheap), then re-render only approved scenes at `1080p`. The cost estimate makes the delta visible before you commit. |
| **Approved reference images seed renders** | An approved character/location still is reused as an image-to-video source, so you don't pay to re-establish a design every scene. |
| **Extend instead of regenerate** | `extendVideo` continues an existing clip rather than rendering a new one from scratch when you only need more at the end. |
| **Fast motion / shorter duration** | `motion_mode: fast` and 5s clips cost less than 8s; the credit table reflects the difference. |
| **Validate first** | Catching an invalid parameter combo (e.g. 1080p @ 8s) before submitting avoids a wasted failed render. |

### PixVerse features to adopt next (not yet wired)

- **First-frame / last-frame control** — pin the start/end frame of a clip to a
  reference image for controlled transitions and better cross-scene continuity
  (fewer re-rolls).
- **Seed reuse** — pin a `seed` to reproduce a near-identical render after a
  small prompt tweak instead of rolling a fresh look each time.
- **Account/credit balance endpoint** — if exposed by your PixVerse plan, poll it
  to show the *real* remaining balance next to the estimate.
