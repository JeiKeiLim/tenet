import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { JobManager } from '../../core/job-manager.js';
import { StateStore } from '../../core/state-store.js';
import { jsonResult, type RegisterTool } from './utils.js';

const CLARITY_RUBRIC = `Score this interview transcript on three dimensions. Use ONLY the transcript content — do not infer answers that were not explicitly given.

## Scoring Dimensions

### Goal Clarity (weight 0.4)
- 1.0: User confirmed acceptance criteria with concrete, testable examples.
- 0.5: User gave general goals but no concrete criteria.
- 0.0: Goals unclear or contradictory.

### Constraint Clarity (weight 0.3)
- 1.0: Tech stack, deployment, and security requirements all confirmed.
- 0.5: Some constraints known, others assumed by the agent.
- 0.0: No constraints discussed.

### Success Criteria Clarity (weight 0.3)
- 1.0: Measurable scenarios defined ("user can X, system does Y").
- 0.5: Vague criteria ("it should work well").
- 0.0: No criteria discussed.

## Output Format
Respond with ONLY this JSON (no markdown, no explanation):
{"goal": <number>, "constraints": <number>, "success_criteria": <number>, "clarity": <number>, "passed": <boolean>, "gaps": ["<missing item 1>", "<missing item 2>"]}

Where clarity = (goal * 0.4) + (constraints * 0.3) + (success_criteria * 0.3), and passed = clarity >= 0.8.
List specific gaps that would need additional interview questions.`;

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
      inputSchema: z.object({}),
    },
    async () => {
      const tenetPath = path.join(stateStore.projectPath, '.tenet');
      const transcriptPath = path.join(tenetPath, 'interview', 'interview.md');

      if (!fs.existsSync(transcriptPath)) {
        throw new Error('Interview transcript not found at .tenet/interview/interview.md — write it before validating');
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
