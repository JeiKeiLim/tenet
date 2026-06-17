import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { JobManager } from '../../core/job-manager.js';
import { StateStore } from '../../core/state-store.js';
import { jsonResult, type RegisterTool } from './utils.js';

const CLARITY_RUBRIC = `Score this interview transcript on three dimensions. Be RIGOROUS — a perfect 1.0 on any dimension is extremely rare and requires exhaustive coverage. Use ONLY the transcript content — do not infer answers that were not explicitly given.

## Scoring Dimensions (use 0.1 increments)

### Goal Clarity (weight 0.4)
- 0.9-0.95: User confirmed acceptance criteria with concrete, testable examples AND edge cases are addressed AND success metrics are quantified.
- 0.8: User confirmed acceptance criteria with concrete examples but some edge cases or metrics are missing.
- 0.6-0.7: User gave general goals with some concrete criteria but gaps remain.
- 0.5: User gave general goals but no concrete criteria.
- 0.0-0.3: Goals unclear or contradictory.
- 1.0 is reserved for: EVERY acceptance criterion is testable, EVERY edge case is addressed, EVERY success metric is quantified with specific numbers. This almost never happens.

### Constraint Clarity (weight 0.3)
- 0.9-0.95: Tech stack, deployment, security, performance targets, and scaling requirements all confirmed with specific versions/numbers.
- 0.8: Tech stack and deployment confirmed, security discussed, but some constraints are implicit.
- 0.6-0.7: Most constraints known but some are assumed by the agent without user confirmation.
- 0.5: Some constraints known, others assumed by the agent.
- 0.0-0.3: No constraints discussed.
- 1.0 is reserved for: EVERY technical constraint is explicit, EVERY version is pinned, EVERY performance target has a number, EVERY security requirement is documented. This almost never happens.

### Success Criteria Clarity (weight 0.3)
- 0.9-0.95: Measurable scenarios defined with exact expected behavior ("user clicks X, sees Y within Z seconds") AND failure scenarios are defined.
- 0.8: Measurable scenarios defined but some are vague on expected outcomes or timing.
- 0.6-0.7: Mix of measurable and vague criteria.
- 0.5: Vague criteria ("it should work well").
- 0.0-0.3: No criteria discussed.
- 1.0 is reserved for: EVERY scenario has exact expected behavior, timing, and error handling defined. EVERY failure mode has a defined response. This almost never happens.

## Scoring Rules
- Be skeptical. If the transcript says "we discussed auth" but doesn't show the actual auth requirements, score it as if auth was NOT discussed.
- Do NOT round up. Use precise values like 0.75, 0.85, etc.
- A score of 0.95 means "nearly perfect, only trivial gaps remain."
- A score of 1.0 means "I cannot identify a single additional question that would improve clarity." Almost never give this.
- ALWAYS include at least one gap, even for high scores. There is always something that could be clarified further.

## Full-mode Delivery Mode Gate

If the transcript declares "Mode: Full", it MUST include "## Delivery Mode Decision" with:
- "Prompt shown"
- "User response"
- "Selected delivery_mode: autonomous|agile"
- "Selection basis: explicit_user_choice|defaulted_after_explicit_choice_prompt|yolo_agent_decision"

For non-YOLO Full mode, the decision must come from a standalone delivery-mode question that presented both "autonomous" and "agile". A bundled defaults question, unrelated "okay", or pre-execution confirmation does NOT satisfy this gate. If this gate fails, set "passed" to false regardless of the numeric clarity score and include the gate failure in "gaps".

## Output Format
Respond with ONLY this JSON (no markdown, no explanation):
{"goal": <number>, "constraints": <number>, "success_criteria": <number>, "clarity": <number>, "passed": <boolean>, "gaps": ["<missing item 1>", "<missing item 2>"]}

Where clarity = (goal * 0.4) + (constraints * 0.3) + (success_criteria * 0.3), and passed = clarity >= 0.8 AND no hard gate fails.
List specific gaps that would need additional interview questions — at minimum 1 gap even for high-scoring transcripts.`;

const FULL_MODE_RE = /^Mode:\s*Full\b/im;
const DELIVERY_MODE_DECISION_RE = /^## Delivery Mode Decision\b/im;
const PROMPT_SHOWN_RE = /^\s*-\s*Prompt shown:\s*\S/im;
const USER_RESPONSE_RE = /^\s*-\s*User response:\s*\S/im;
const SELECTED_DELIVERY_MODE_RE = /^\s*-\s*Selected delivery_mode:\s*(autonomous|agile)\b/im;
const SELECTION_BASIS_RE =
  /^\s*-\s*Selection basis:\s*(explicit_user_choice|defaulted_after_explicit_choice_prompt|yolo_agent_decision)\b/im;

const getFullModeDeliveryGateFailure = (transcript: string): string | null => {
  if (!FULL_MODE_RE.test(transcript)) {
    return null;
  }

  if (!DELIVERY_MODE_DECISION_RE.test(transcript)) {
    return 'Full-mode transcript is missing ## Delivery Mode Decision.';
  }

  if (!PROMPT_SHOWN_RE.test(transcript)) {
    return 'Full-mode transcript has ## Delivery Mode Decision but no Prompt shown.';
  }

  if (!USER_RESPONSE_RE.test(transcript)) {
    return 'Full-mode transcript has ## Delivery Mode Decision but no User response.';
  }

  if (!SELECTED_DELIVERY_MODE_RE.test(transcript)) {
    return 'Full-mode transcript has ## Delivery Mode Decision but no valid Selected delivery_mode.';
  }

  if (!SELECTION_BASIS_RE.test(transcript)) {
    return 'Full-mode transcript has ## Delivery Mode Decision but no valid Selection basis.';
  }

  return null;
};

const createCompletedClarityFailureJob = (
  jobManager: JobManager,
  stateStore: StateStore,
  gap: string,
) => {
  const now = Date.now();
  const job = jobManager.createPendingJob('eval', {
    name: 'clarity-delivery-mode-gate',
    prompt: `Deterministic clarity gate failure: ${gap}`,
    eval_type: 'clarity_validation',
  });

  stateStore.setJobOutput(job.id, {
    goal: 0,
    constraints: 0,
    success_criteria: 0,
    clarity: 0,
    passed: false,
    gaps: [gap],
  });
  stateStore.updateJob(job.id, {
    status: 'completed',
    startedAt: now,
    completedAt: now,
    lastHeartbeat: now,
  });
  stateStore.appendEvent(job.id, 'job_completed', { deterministic: true });

  return job;
};

const RUN_SLUG_FEATURE_PATTERN = /^\d{4}-\d{2}-\d{2}-(.+)$/;

/**
 * Extract the feature slug from a run directory name shaped `{date}-{feature}`.
 * Returns undefined for anything that is not a dated run slug, so unrelated
 * directories are never matched by feature. Exact comparison avoids the suffix
 * ambiguity where feature "auth" would match a run slug ending in "-oauth".
 */
const runSlugFeature = (dirName: string): string | undefined => {
  const match = dirName.match(RUN_SLUG_FEATURE_PATTERN);
  return match ? match[1] : undefined;
};

export const registerTenetValidateClarityTool = (
  registerTool: RegisterTool,
  jobManager: JobManager,
  stateStore: StateStore,
): void => {
  registerTool(
    'tenet_validate_clarity',
    {
      description:
        'Dispatch a fresh agent to independently score the interview clarity. ' +
        'Call this AFTER writing the interview transcript. The agent reads ONLY the transcript ' +
        'and scores it without seeing the interview conversation. Returns pass/fail + gaps.',
      inputSchema: z.object({
        feature: z.string().optional().describe('Feature slug to find the interview transcript (e.g. "oauth"). If omitted, uses the latest interview file or falls back to interview.md.'),
      }),
    },
    async ({ feature }) => {
      const tenetPath = path.join(stateStore.projectPath, '.tenet');
      const runsDir = path.join(tenetPath, 'runs');
      const interviewDir = path.join(tenetPath, 'interview');

      let transcriptPath: string | undefined;

      // With a feature, only feature-matched transcripts are ever selected:
      //   run-local {date}-{feature}/interview.md, then legacy interview/*-{feature}.md.
      // Without a feature, fall back to the latest run interview, then the latest
      // legacy file. The generic interview.md singleton is the final fallback.
      // We never silently validate one feature's transcript for a different feature.
      if (feature && fs.existsSync(runsDir)) {
        const matches = fs
          .readdirSync(runsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && runSlugFeature(entry.name) === feature)
          .map((entry) => entry.name)
          .sort();
        for (const runSlug of matches.slice().reverse()) {
          const candidate = path.join(runsDir, runSlug, 'interview.md');
          if (fs.existsSync(candidate)) {
            transcriptPath = candidate;
            break;
          }
        }
      }

      if (!transcriptPath && !feature && fs.existsSync(runsDir)) {
        const candidates = fs
          .readdirSync(runsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(runsDir, entry.name, 'interview.md'))
          .filter((candidate) => fs.existsSync(candidate))
          .sort();
        if (candidates.length > 0) {
          transcriptPath = candidates[candidates.length - 1];
        }
      }

      if (!transcriptPath && feature && fs.existsSync(interviewDir)) {
        const suffix = `-${feature}.md`;
        const matches = fs.readdirSync(interviewDir).filter((f) => f.endsWith(suffix)).sort();
        if (matches.length > 0) {
          transcriptPath = path.join(interviewDir, matches[matches.length - 1]);
        }
      }

      if (!transcriptPath && !feature && fs.existsSync(interviewDir)) {
        const allMd = fs.readdirSync(interviewDir).filter((f) => f.endsWith('.md')).sort();
        if (allMd.length > 0) {
          transcriptPath = path.join(interviewDir, allMd[allMd.length - 1]);
        }
      }

      if (!transcriptPath) {
        transcriptPath = path.join(interviewDir, 'interview.md');
      }

      if (!fs.existsSync(transcriptPath)) {
        throw new Error('Interview transcript not found — write it to .tenet/runs/<run-slug>/interview.md before validating. Legacy .tenet/interview/{date}-{feature}.md remains a compatibility fallback.');
      }

      const transcript = fs.readFileSync(transcriptPath, 'utf8');
      const deliveryGateFailure = getFullModeDeliveryGateFailure(transcript);

      if (deliveryGateFailure) {
        const job = createCompletedClarityFailureJob(jobManager, stateStore, deliveryGateFailure);

        return jsonResult({
          job_id: job.id,
          message:
            'Clarity validation failed before dispatch. Use tenet_job_result to read the gate failure.',
        });
      }

      const prompt = `${CLARITY_RUBRIC}\n\n---\n\n# Interview Transcript\n\n${transcript}`;

      const job = jobManager.startJob('eval', {
        prompt,
        eval_type: 'clarity_validation',
      });

      return jsonResult({
        job_id: job.id,
        message: 'Clarity validation dispatched. Use tenet_job_wait + tenet_job_result to get the score.',
      });
    },
  );
};
