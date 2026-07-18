---
id: TASK-046
title: >-
  Research paper: What's Your Agent's GPA? — supports Tenet multi-critic
  approach
status: To Do
assignee: []
created_date: '2026-07-15 01:21'
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

