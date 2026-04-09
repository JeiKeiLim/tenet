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

## Output Format
Respond with ONLY this JSON (no markdown, no explanation):
{"goal": <number>, "constraints": <number>, "success_criteria": <number>, "clarity": <number>, "passed": <boolean>, "gaps": ["<missing item 1>", "<missing item 2>"]}

Where clarity = (goal * 0.4) + (constraints * 0.3) + (success_criteria * 0.3), and passed = clarity >= 0.8.
List specific gaps that would need additional interview questions — at minimum 1 gap even for high-scoring transcripts.`;

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
      const interviewDir = path.join(tenetPath, 'interview');

      let transcriptPath: string | undefined;

      // Try feature-scoped first, then latest file in dir, then singleton fallback
      if (feature && fs.existsSync(interviewDir)) {
        const suffix = `-${feature}.md`;
        const matches = fs.readdirSync(interviewDir).filter((f) => f.endsWith(suffix)).sort();
        if (matches.length > 0) {
          transcriptPath = path.join(interviewDir, matches[matches.length - 1]);
        }
      }

      if (!transcriptPath && fs.existsSync(interviewDir)) {
        const allMd = fs.readdirSync(interviewDir).filter((f) => f.endsWith('.md')).sort();
        if (allMd.length > 0) {
          transcriptPath = path.join(interviewDir, allMd[allMd.length - 1]);
        }
      }

      if (!transcriptPath) {
        transcriptPath = path.join(interviewDir, 'interview.md');
      }

      if (!fs.existsSync(transcriptPath)) {
        throw new Error('Interview transcript not found — write it to .tenet/interview/{date}-{feature}.md before validating');
      }

      const transcript = fs.readFileSync(transcriptPath, 'utf8');

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
