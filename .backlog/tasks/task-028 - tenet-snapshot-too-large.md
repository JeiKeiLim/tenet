---
id: TASK-028
title: tenet snapshot too large
status: Done
assignee: []
created_date: '2026-07-07 02:17'
updated_date: '2026-07-07 02:17'
labels: []
dependencies: []
priority: low
ordinal: 28000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
tenet snapshot became >100MB blocking git push. Delivered (v26.6.8): tenet db snapshot writes gzip-compressed tenet.db.gz by default. --no-compress keeps plain file. restore-snapshot auto-detects format.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Snapshot compresses with gzip level 9 by default
- [ ] #2 Restore auto-detects gzip vs plain via magic bytes
- [ ] #3 CLI smoke test showed 98% compression on tiny DB
<!-- AC:END -->
