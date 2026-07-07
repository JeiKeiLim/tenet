---
id: TASK-030
title: Better playwright critic — interaction e2e
status: Done
assignee: []
created_date: '2026-07-07 02:17'
updated_date: '2026-07-07 02:17'
labels: []
dependencies: []
priority: low
ordinal: 30000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Playwright critic became playwright-only and skipped non-GUI projects. Should run e2e CLI tests too. Delivered: CLI/API/library branches get same exploratory agent-brain rigor as browser branch. Renamed from playwright_eval to interaction_e2e.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Non-browser e2e paths get same exploratory rigor as browser
- [ ] #2 Docs no longer signal 'browser-only'
- [ ] #3 Internal identifiers renamed with DB schema migration
<!-- AC:END -->
