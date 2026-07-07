---
id: TASK-017
title: Prevent .tenet/.state/tenet.db from being committed
status: Done
assignee: []
created_date: '2026-07-07 02:17'
updated_date: '2026-07-07 02:17'
labels: []
dependencies: []
priority: low
ordinal: 17000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
tenet.db corruption likely from git. Delivered: tenet init/--upgrade detects tracked tenet.db via git ls-files and warns with exact git rm --cached command. Also appends .tenet/.state/ to .gitignore.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 tenet init detects already-tracked tenet.db and warns user
- [ ] #2 .tenet/.state/ is appended to .gitignore
<!-- AC:END -->
