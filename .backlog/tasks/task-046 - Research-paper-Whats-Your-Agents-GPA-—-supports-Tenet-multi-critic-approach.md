---
id: TASK-046
title: >-
  Research paper: What's Your Agent's GPA? — supports Tenet multi-critic
  approach
status: Done
assignee: []
created_date: '2026-07-15 01:21'
updated_date: '2026-10-13 00:42'
labels:
  - research
  - tenet
  - reference
dependencies: []
ordinal: 46000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Research paper "What Is Your Agent's GPA? A Framework for Evaluating Agent Goal-Plan-Action Alignment" (arXiv:2510.08847, Oct 2025) by Jia et al. from Carnegie Mellon / TruEra.

Key findings relevant to Tenet:
- Uses 6 specialized LLM judges (Logical Consistency, Execution Efficiency, Plan Adherence, Plan Quality, Tool Selection, Tool Calling) instead of a single monolithic judge
- Single monolithic LLM judge is fragile — TRAIL benchmark shows even strongest LLM achieves only 11% accuracy as a single judge
- "No single judge is universally optimal"
- "No single judge is reliable across all conditions"
- "Specialized judges provide more reliable and interpretable assessments than monolithic evaluators"
- Strong inter-rater agreement (Krippendorff's alpha > 0.7 for most metrics)
- 5 independent runs per judge for consistency

This directly supports Tenet's multi-critic evaluation architecture. Worth reading the full paper for deeper methodology alignment.
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
CLOSED 2026-10-13 (backlog cleanup audit, adversarially verified) as superseded: pure citation note with no ACs/DoD; the validated architecture it supports - the configurable .tenet/critics.json multi-critic roster, shipped in 9f5e9b2 - is live and working daily at 26.9.0. The arXiv:2510.08847 citation was preserved on kept-open TASK-045 so the research pointer stays where it is actionable.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Superseded: the multi-critic architecture the paper supports is shipped and in daily use; citation preserved on TASK-045.
<!-- SECTION:FINAL_SUMMARY:END -->
