# 03: Visual Artifact Generation

Visual generation is mandatory in Full mode. These artifacts bridge the gap between interview and specification, ensuring alignment on system design and UI expectations.

## Output Requirements
- **Directory**: `.tenet/visuals/`
- **Naming**: `{date}-NN-description.html` (e.g., `2026-04-08-00-architecture.html`, `2026-04-08-01-mockup-minimal.html`). The date prefix tells future sessions when the visual was created so they can decide if it needs updating.
- **Self-Contained**: No external dependencies. Inline all CSS, SVG, and JS.
- **Realistic**: Use plausible sample data. No "Lorem ipsum".

## 1. Architecture Diagrams
Required for all multi-component systems.
- **Format**: SVG elements (`<svg>`, `<line>`, `<rect>`, `<path>`) for true vector connections.
- **Requirement**: Must show explicit data flow and relationships via arrows/lines. Styled CSS boxes alone are unacceptable.
- **Interactive**: Support hover effects for detail and responsive scaling.

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
- **Quantity**: Generate 3-5 materially different design variations.
- **Variations**: Differ in layout, color scheme, and information density.
- **Approval**: Present all variations to the user. They must select or approve one before proceeding to the spec phase.

## 3. DESIGN.md (Frontend Projects Only)

After the user approves a mockup design, write `.tenet/DESIGN.md` to capture the chosen design principles. This document ensures visual consistency across all future jobs.

**When to write:** Immediately after the user selects/approves a mockup variation.

**Content:**
```markdown
# Design System

## Chosen Direction
- Selected mockup: [reference to approved file]
- Design rationale: [why this direction was chosen]

## Visual Principles
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
```

**Evolution:** Update DESIGN.md during implementation as new patterns emerge (new component types, responsive adjustments). Dev jobs that touch frontend MUST read DESIGN.md before writing CSS/components.

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

## Anti-Skip Enforcement
Visual generation is not optional. Do not skip this step even if the requirements seem clear. If a project has a UI, mockups are mandatory. Architecture diagrams are mandatory for all systems. Interactive prototypes are mandatory after design lock-in.
