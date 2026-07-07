---
id: TASK-027
title: Design-component skip in context bootstrap
status: Done
assignee: []
created_date: '2026-07-07 02:17'
updated_date: '2026-07-07 02:17'
labels: []
dependencies: []
priority: low
ordinal: 27000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
design-component mention was too thin. After migration from v26.6.0 to v26.6.1, context bootstrap didn't generate design-components document for a SaaS project with frontend design. Delivered: 00-context-bootstrap.md now tells bootstrap to populate project/design-components/ when visual/UI surface is detected.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Context bootstrap populates design-components/ when visual/UI surface detected
- [ ] #2 Empty dir in clearly-frontend project is flagged, not silently skipped
<!-- AC:END -->
