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

## Anti-Skip Enforcement
Visual generation is not optional. Do not skip this step even if the requirements seem clear. If a project has a UI, mockups are mandatory. Architecture diagrams are mandatory for all systems.
