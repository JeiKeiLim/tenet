# 03: Visual Artifact Generation

Visual generation is mandatory in Full mode. These artifacts bridge the gap between interview and specification, ensuring alignment on system design and UI expectations.

**Before producing any artifacts, determine `delivery_mode`**. Prefer the spec's front-matter field when the spec already exists (see `phases/02-spec-and-harness.md` § 2.1). If visuals run before spec generation in Full mode, use `## Delivery Mode Decision` from the interview transcript; if it is missing, stop and return to `phases/01-interview.md`. Do not silently default in Full mode. When `delivery_mode: agile`, Section 5 below overrides parts of Sections 1–4 — agile reshapes the output into a final-product view + per-slice wireframes rather than 3-5 variations, and adds a mid-run delta workflow. When `delivery_mode: autonomous` (or absent in non-Full/legacy flows), follow Sections 1–4 as written and ignore Section 5.

## Output Requirements
- **Directory**: `.tenet/runs/{run_slug}/visuals/`
- **Naming**: `{date}-NN-description.html` (e.g., `2026-04-08-00-architecture.html`, `2026-04-08-01-mockup-minimal.html`). The date prefix tells future sessions when the visual was created so they can decide if it needs updating.
- **Self-Contained**: No external dependencies. Inline all CSS, SVG, and JS.
- **Realistic**: Use plausible sample data. No "Lorem ipsum".
- **Doctrine**: Read `.tenet/project/design.md` before creating artifacts. If `.tenet/project/design-components/` exists and is non-empty, you MUST inspect every file in it and preserve the established component patterns in every mockup and prototype you produce. Do not skip this directory — it holds the accepted examples that define the look and feel all future visual work must match.

## 1. Architecture Diagrams
Required for all multi-component systems.
- **Format**: SVG elements (`<svg>`, `<line>`, `<rect>`, `<path>`) for true vector connections.
- **Requirement**: Must show explicit data flow and relationships via arrows/lines. Styled CSS boxes alone are unacceptable.
- **Interactive**: Support hover effects for detail and responsive scaling.
- **Agile-mode note**: The upfront pass always produces a final-product architecture diagram (entire system, all slices combined). Mid-run, architecture is re-fired only on structural redirects (new external service, schema shift, etc.) — see Section 5.

```html
<svg width="800" height="400" viewBox="0 0 800 400">
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
      <polygon points="0 0, 10 3.5, 0 7" fill="#64748b"/>
    </marker>
  </defs>
  <rect x="50" y="50" width="160" height="60" rx="8" fill="#1e293b" stroke="#3b82f6"/>
  <text x="130" y="85" text-anchor="middle" fill="#f8fafc" font-family="sans-serif">Frontend SPA</text>
  <path d="M 210 80 L 340 80" stroke="#64748b" stroke-width="2" marker-end="url(#arrow)"/>
</svg>
```

## 2. UI Mockups
Required for all UI-facing projects.
- **Quantity (autonomous mode)**: Generate 3-5 materially different design variations.
- **Variations**: Differ in layout, color scheme, and information density.
- **Approval**: Present all variations to the user. They must select or approve one before proceeding to the spec phase.
- **Agile-mode override**: Replace the 3-5 variation pass with a single cohesive final-product mockup plus one wireframe per slice. See Section 5.1.

## 3. Run Design Delta

After the user approves a mockup design, write `.tenet/runs/{run_slug}/design.md` to capture the run-local design decisions and deltas from `.tenet/project/design.md`.

**When to write:** Immediately after the user selects/approves a mockup variation.

**Content:**
```markdown
# Run Design Direction

## Chosen Direction
- Selected mockup: [reference to approved file]
- Design rationale: [why this direction was chosen]
- Project design doctrine used: `.tenet/project/design.md`
- Accepted component examples consulted: [list every `.tenet/project/design-components/*` file inspected, or "none — directory absent/empty" with a one-line reason]

## Run-Local Visual Principles
- Color palette: [primary, secondary, accent, background colors with hex codes]
- Typography: [font families, sizes, weights]
- Spacing: [spacing scale or pattern]
- Border radius: [rounded corners pattern]

## Component Patterns
- Buttons: [style description]
- Forms: [input style, validation display]
- Cards/containers: [shadow, border, padding]
- Navigation: [layout, active state]

## Layout
- Grid system: [columns, breakpoints]
- Responsive strategy: [mobile-first, breakpoints]

## Proposed Project Doctrine Updates
- [Only list proposals. Normal run work must not edit `.tenet/project/**`.]
```

**Evolution:** Implementation jobs may update `.tenet/runs/{run_slug}/design.md` as run-local patterns emerge. They must not update `.tenet/project/design.md` or `.tenet/project/design-components/` unless the user explicitly requested project doctrine maintenance.

## 4. Interactive Prototypes (after design lock-in)

After the user approves a design variation, build a clickable HTML prototype that simulates the core user flows. This lets the user experience how the product will **behave** before any real code is written.

**When to build:** Immediately after design approval, before spec finalization.

**Applies to all project types:**
- **Web apps**: Interactive HTML with buttons, forms, page transitions, simulated data
- **TUI/CLI**: HTML simulation of terminal output, command sequences, menu navigation
- **APIs**: Interactive request/response flow diagrams with sample payloads
- **Libraries**: Usage example simulations showing input → output flows

**Requirements:**
- **Self-contained HTML** (same rules as mockups — no external dependencies)
- **Naming**: `{date}-NN-prototype-{flow}.html` (e.g., `2026-04-09-04-prototype-signup-flow.html`)
- **Clickable**: User clicks through the flow (buttons advance to next screen, forms show validation, etc.)
- **Realistic data**: Use plausible sample data, not placeholders
- **Cover core flows**: At minimum, prototype the happy path for each primary user journey
- **Show state transitions**: Login → authenticated state, create → item in list, submit → confirmation

**Example structure for a web app prototype:**
```html
<!-- Each "screen" is a div, JS toggles visibility on button click -->
<div id="screen-login" class="screen active">
  <h2>Login</h2>
  <input placeholder="email" /><input type="password" placeholder="password" />
  <button onclick="showScreen('screen-dashboard')">Sign In</button>
</div>
<div id="screen-dashboard" class="screen">
  <h2>Dashboard</h2>
  <p>Welcome, jane@example.com</p>
  <!-- Shows the items, nav links, etc. -->
</div>
```

**Example for CLI/TUI prototype:**
```html
<!-- Simulated terminal with step-by-step command output -->
<div class="terminal">
  <pre>$ tenet init
Initialized Tenet scaffold at .tenet/
Default agent: claude-code</pre>
  <button onclick="showNext()">Next command →</button>
</div>
```

**User approval:** Present the prototype to the user. They must click through the flows and confirm the behavior matches their expectations before proceeding to spec.

**Agile-mode note:** The prototype becomes a slice walkthrough — clicking "next slice" advances through the planned slice progression so the user can preview what each use-checkpoint will deliver. See Section 5.1.

## 5. Agile-mode adaptations (when `delivery_mode: agile`)

This section overrides parts of Sections 1–4 when the spec's front matter declares `delivery_mode: agile`. Read the spec's `## Slice plan` first — every adaptation below maps to that plan.

### 5.1 Upfront pass (before the initial plan-checkpoint)

Produce three artifacts that together preview the entire product:

1. **Final-product architecture diagram** — same format as Section 1, scoped to the *complete* product (all slices combined). This is the system-level destination the user is signing off on at the plan-checkpoint.
   - File: `.tenet/runs/{run_slug}/visuals/{date}-NN-architecture.html` (one canonical file)

2. **Final-product UI mockup** — ONE cohesive mockup (not 3-5 variations). It shows the final state of the app after every slice ships. The user is approving the destination, not picking between styles.
   - File: `.tenet/runs/{run_slug}/visuals/{date}-NN-final-product.html`
   - If the user wants stylistic alternatives, run a tiny variation pass (2-3 alts) on top, but treat them as variants of the same destination, not entirely different products.

3. **Per-slice wireframes** — one mockup per slice listed in the spec's `## Slice plan`. Each shows the app's UI state at the use-checkpoint for that slice — what the user will actually see and click when slice N's eval passes.
   - File: `.tenet/runs/{run_slug}/visuals/{date}-NN-slice-M-{slice-name}.html` (M is the slice number, 1-indexed)
   - Wireframes are **additive**, mirroring the slice plan: slice 2's wireframe contains everything from slice 1 plus slice 2's new capability.

The interactive prototype (Section 4) becomes a slice walkthrough: clicking "next slice" advances through the planned progression so the user can preview each use-checkpoint. This walkthrough is what the user reviews at the initial plan-checkpoint.

### 5.2 Mid-run pass (after a redirect at a use-checkpoint)

The mockup phase re-fires only when a redirect changes design. Produce *targeted deltas*, not a re-do:

| Redirect type | Mockup output |
|---|---|
| Pure visual tweak (color, layout, copy) | UI delta only — replace the affected slice's wireframe; architecture unchanged |
| New external service / schema shift / structural change | UI delta + architecture delta — update both, scoped to the affected slice |
| Pure reorder of slice plan (no design change) | No mockup work — skip this phase, go straight to readiness/build |
| Adding a new slice | One new wireframe for the new slice + architecture delta if the slice introduces new structure |

File the deltas alongside the originals using a `-revision-K` suffix (K is the revision count for that artifact, 1-indexed):
- `.tenet/runs/{run_slug}/visuals/{date}-NN-slice-M-{slice-name}-revision-K.html`
- `.tenet/runs/{run_slug}/visuals/{date}-NN-architecture-revision-K.html`

Do NOT overwrite the original wireframes — the revision history is part of the audit trail the user uses at the next plan-checkpoint.

The redirect router (step 6 of the agile-mode rollout, see `docs/planning/14_agile_mode.md`) decides whether mockup re-fires; this section just defines the output shape when it does.

### 5.3 What does NOT change in agile mode

- Section 3 (run design delta) — same trigger (after design lock-in on the final-product mockup).
- "Output Requirements" rules (self-contained, realistic data, naming convention) still hold.
- Anti-Skip Enforcement still applies — agile mode does not skip mockup; it reshapes it.

## Anti-Skip Enforcement
Visual generation is not optional. Do not skip this step even if the requirements seem clear. If a project has a UI, mockups are mandatory. Architecture diagrams are mandatory for all systems. Interactive prototypes are mandatory after design lock-in. The Section 5 agile-mode adaptations apply *in addition* to this rule, not as an exception to it.
