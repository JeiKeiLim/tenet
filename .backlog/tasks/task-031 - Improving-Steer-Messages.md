---
id: TASK-031
title: Improving Steer Messages
status: Done
assignee: []
created_date: '2026-07-07 02:17'
updated_date: '2026-07-07 02:17'
labels: []
dependencies: []
priority: low
ordinal: 31000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Agent kept adding steer messages without cleanup, leading to 400k+ steer messages. Delivered: tenet_update_steer retires/sweeps steers; tenet_process_steer returns user steers in full and caps agent steers.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Steer messages are sweepable and capped
- [ ] #2 User steers retire only by explicit ID
<!-- AC:END -->
