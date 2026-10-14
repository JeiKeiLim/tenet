---
id: TASK-052
title: >-
  Integration suite flaky under load — C8/C14 time out in make check, pass
  standalone
status: To Do
assignee: []
created_date: '2026-08-18 22:55'
labels:
  - bug
  - test
dependencies: []
priority: medium
ordinal: 52000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-08-13 while running make check repeatedly on the retry PR branch: src/core/integration.test.ts intermittently times out under make check's load (build+typecheck+lint run first, then the full test suite). Different tests flake on different runs — C8 (round-id gate) timed out at 5000ms once, C14 (per-stage) at 15000ms another time. The standalone 
 RUN  v4.1.2 /Users/limjk/GitHub/JeiKeiLim/tenet

 Test Files  29 passed (29)
      Tests  366 passed (366)
   Start at  07:54:48
   Duration  52.94s (transform 1.78s, setup 0ms, import 3.50s, tests 86.37s, environment 2ms) passes 366/366 consistently. Root cause hypothesis: the integration tests use real timers with 5-15s timeouts and a FakeAdapter; under CPU load from the preceding build/typecheck/lint, some tests exceed their timeouts. Not a regression from the retry changes (they touch no integration-test logic). Fix directions: raise the per-test timeout for the integration suite, or reduce wall-clock contention (e.g. run test in isolation from build/typecheck/lint, or make the harness's waitForJob deadline adaptive).
<!-- SECTION:DESCRIPTION:END -->
