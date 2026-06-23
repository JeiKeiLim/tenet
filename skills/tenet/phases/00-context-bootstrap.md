# Phase 00: Context Bootstrap

This phase establishes usable project doctrine under `.tenet/project/` before normal Tenet work begins. It replaces the old brownfield-only scan. The goal is not to rate documentation quality; the goal is a pass/fail decision about whether ordinary jobs have a trustworthy project baseline.

## When To Run

Run the bootstrap gate before interview, spec, decomposition, or execution.

The gate passes only when all required files exist and are usable:

- `.tenet/project/overview.md`
- `.tenet/project/architecture.md`
- `.tenet/project/product.md`
- `.tenet/project/testing.md`
- `.tenet/project/design.md`

Fail the gate when `.tenet/project/` is missing, any required file is missing, or a required file is empty, placeholder-only, or an obvious template. Do not score documents as thin, stale, incomplete, or improvable. Those judgments belong to explicit lifecycle maintenance, not bootstrap. That lifecycle is the **doctrine drift review** at run completion (`phases/05-execution-loop.md`): jobs flag stale doctrine as drift notes, the run end consolidates them into proposals under `.tenet/runs/<run>/doctrine-proposals.md`, and an authorized doctrine-maintenance job (`allow_project_doctrine_edits: true`) applies accepted ones and **re-runs this gate** to confirm coherence.

When the gate fails, stop normal Tenet work and run this phase. Do not proceed to interview, spec, decomposition, execution, or eval until the gate passes.

## Authority And Evidence Order

Bootstrap is live-scan-first. Synthesize final `project/**` docs from evidence in this order:

1. Current repository implementation and directory structure.
2. Current tests, package scripts, config, CI, and runtime behavior.
3. Recent explicit user/project decisions.
4. Archived legacy Tenet evidence under `.tenet/archive/legacy-v1/` (populated by `tenet init --upgrade` on existing projects), only when it clarifies intent or durable lessons that still match the live project.

Legacy evidence is secondary. Do not copy migration commentary, old conflict notes, or "legacy said X but code says Y" analysis into final `project/**` docs. Final project docs describe the current baseline only.

Do not edit source code, production config, tests, or runtime state during bootstrap unless the user explicitly asks for a separate implementation change.

## Required Sub-Agent Investigation

The main agent is the orchestrator and synthesizer. Use bounded parallel sub-agents for investigation lanes when the host supports them. A useful default split:

| Lane | Main question |
|---|---|
| Live overview | What is the repository now, and what directory/module rules matter? |
| Live architecture | What are the current runtime boundaries, data flow, integrations, and persistence model? |
| Live product | What user-facing behavior is currently implemented? |
| Live testing | How is quality verified now, and which commands/fixtures/CI paths are authoritative? |
| Live design | What frontend, CLI, API, TUI, or other interaction-surface conventions are implemented now? |
| Legacy intent | What product direction or long-term constraints can be recovered from archived specs, decompositions, or interviews? |
| Legacy operations | What workflow, harness, retry, status, or journal lessons should survive? |
| Legacy design | What accepted visual/design decisions can be recovered from archived design and visual artifacts? |
| Legacy knowledge | What durable facts in archived knowledge should be curated forward? |

Skip legacy lanes when `.tenet/archive/legacy-v1/` is absent or empty.

Each sub-agent report must include:

- claim,
- source path or command,
- evidence type: code, test, config, runtime, legacy spec, journal, visual, or knowledge,
- whether the claim describes current implementation or legacy intent,
- confidence,
- uncertainty or contradiction,
- suggested destination: `project/overview.md`, `project/architecture.md`, `project/product.md`, `project/testing.md`, `project/design.md`, `project/design-components/`, or `knowledge/*`.

If sub-agents are unavailable, stop and ask the user before using degraded main-agent-only mode. In degraded mode, first write the lane plan, then persist intermediate lane findings under `.tenet/runs/<run>/research/` before each lane so work survives context compaction or restart.

## Synthesis Outputs

Write or refresh:

```text
.tenet/project/
  overview.md
  architecture.md
  product.md
  testing.md
  design.md
  design-components/     # expected when the project has a visual/UI surface
```

`project/design.md` is required for every project. It is experience-design doctrine: public/user-facing flows, operational surfaces, language and feedback, accessibility and responsiveness when relevant, visual system when relevant, and anti-patterns that would make the project feel wrong. Technical architecture belongs in `project/architecture.md`.

`project/design-components/` holds self-contained accepted component examples — one HTML/MD file per component (buttons, cards, forms, empty states, navigation, etc.) using realistic sample data and pointing at the real source that implements each pattern. It is the canonical reference future visual and implementation work must preserve. It is optional ONLY for projects with no visual/UI interaction surface. When the "Live design" investigation lane finds a frontend, web UI, mobile UI, TUI, or other visual interaction surface, populate `design-components/` with the patterns already implemented in the codebase rather than leaving it empty. An empty or missing `design-components/` in a project that clearly has a frontend is a gap to flag for follow-up (record it as a follow-up or ask the user) — not a reason to silently skip it.

Bootstrap may also curate durable reusable facts into top-level `.tenet/knowledge/`. Do not promote raw research dumps or run-local history as knowledge unless they have been deduplicated into concern-oriented facts that will help future work.

## Output Rules

- Final `project/**` docs must describe the current project baseline only.
- Do not include migration commentary, provenance sections, or unresolved legacy conflict analysis in final project docs.
- If an important ambiguity cannot be resolved from evidence, ask the user or record a follow-up instead of encoding a guess as doctrine.
- Do not reconstruct historical top-level specs or decompositions as fake runs.
- Do not keep archived legacy evidence under `.tenet/archive/legacy-v1/` (harness/DESIGN/spec/interview) as active doctrine; it is reference-only.
- Do not include `.tenet/status/` in project doctrine. Steer messages live in the MCP SQLite store, not files.

## Handoff To Normal Work

After synthesis, re-run the bootstrap gate. If it passes, continue to mode selection and the next phase. If it still fails, report the exact missing or placeholder project docs and stop.
