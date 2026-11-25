import { z } from 'zod';
import { JobManager } from '../../core/job-manager.js';
import { StateStore } from '../../core/state-store.js';
import type { Job } from '../../types/index.js';
import { jsonResult, type RegisterTool } from './utils.js';
import { startJobResponse } from './tenet-start-job.js';

/**
 * Bespoke adviser preamble. Deliberately NOT the report_only path: report-only jobs
 * are instructed to call tenet_report_blocking_finding and describe a child-dev-job
 * resume flow — the adviser has no Tenet MCP tools and must never spawn remediation.
 * Read-only is prompt-enforced only (frontier-capability model); the adviser's edge
 * over the worker is full-repo access plus evidence discipline.
 */
const ADVISER_PREAMBLE = [
  '## Adviser — decision-point consultation',
  '',
  'You are an ADVISER MODEL consulted at a decision point in a Tenet autonomous run.',
  'A worker job hit a blocker the orchestrator cannot resolve on its own. You are not',
  'the worker and not the orchestrator: your job is judgment backed by evidence.',
  '',
  '### Read-only by instruction',
  'Investigate the repository freely (read files; run read-only commands such as tests,',
  'grep, or builds when they help), but DO NOT modify files and DO NOT attempt',
  'remediation. You have no Tenet MCP tools and cannot dispatch jobs — recommendation only.',
  '',
  '### Full-repo edge',
  'Unlike the worker, you see the whole repository. Cross-check ALL acceptance and',
  'frozen tests, the spec, and the harness relevant to this decision — not just the',
  'ones the question cites. A relevant test outside the cited set is exactly what a',
  'worker focused on one job tends to miss.',
  '',
  '### Guardrail',
  'Verify every worker-cited claim against the repository before trusting it. The',
  'framing of the question — including the option list it offers — can itself be wrong.',
  'If none of the offered options is correct, say so and propose the correct one.',
  '',
  '### Output contract — respond with EXACTLY ONE of these sections',
  '1. `## RECOMMENDATION` — what to do, with file:line evidence, what the prior',
  '   attempts got wrong, and paste-ready text the orchestrator can use as an',
  '   enhanced retry prompt.',
  '2. `## GENUINELY USER\'S CALL` — when the decision needs human preference or',
  '   authority: a distilled decision frame (options, trade-offs, and the single',
  '   question the user must answer).',
  '',
  'Be decisive and cite evidence. Do not hedge between the two sections.',
].join('\n');

type RunContextPointers = {
  lines: string[];
  runPath?: string;
  artifactPaths?: Record<string, unknown>;
};

const asArtifactPathsRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Artifact pointers resolved from a source job record. All jobs in a run share the
 * same run_path/artifact_paths, so any one anchor job resolves identical lines.
 * Pointers are PATHS ONLY — the adviser reads the files itself; nothing is inlined.
 * Missing/null entries are omitted (artifact_paths allows null for optional docs).
 */
const resolveRunContextPointers = (job: Job): RunContextPointers => {
  const lines: string[] = [];
  const runPath =
    typeof job.params.run_path === 'string' && job.params.run_path.length > 0
      ? job.params.run_path
      : undefined;
  if (runPath) {
    lines.push(`- run dir: ${runPath}`);
  }

  const artifactPaths = asArtifactPathsRecord(job.params.artifact_paths);
  if (artifactPaths) {
    for (const key of ['spec', 'harness', 'scenarios', 'decomposition'] as const) {
      const value = artifactPaths[key];
      if (typeof value === 'string' && value.length > 0) {
        lines.push(`- ${key}: ${value}`);
      }
    }
  }

  return { lines, runPath, artifactPaths };
};

const buildAdviserPrompt = (question: string, pointerLines: string[]): string => {
  const sections: string[] = [ADVISER_PREAMBLE];
  if (pointerLines.length > 0) {
    sections.push('', '## Run Context (paths only — read these files from the repo)', ...pointerLines);
  }
  sections.push('', '## Escalation Question', '', question);
  return sections.join('\n');
};

export const registerTenetAskAdviserTool = (
  registerTool: RegisterTool,
  jobManager: JobManager,
  stateStore: StateStore,
): void => {
  registerTool(
    'tenet_ask_adviser',
    {
      description:
        'Consult the configured adviser model at a decision point where you would otherwise halt and ask the ' +
        'user: repeated identical worker failures with an unchanged approach, a worker report offering mutually ' +
        'exclusive options, a change the harness forbids, or spec ambiguity between frozen tests. Pass the composed ' +
        'escalation question (quote worker reports verbatim when they surfaced options) and the source job ids it ' +
        'is about; related parallel failures share one call, unrelated ones are separate calls. The adviser has ' +
        'full-repo read access (paths only, no inlined docs) and returns either a grounded RECOMMENDATION usable ' +
        'as an enhanced retry prompt or a GENUINELY USER\'S CALL decision frame. If no adviser is configured the ' +
        'tool returns adviser_configured: false — surface the question to the user exactly as you do today. ' +
        'Wait via tenet_job_wait, collect via tenet_job_result; a completed adviser job NEVER triggers ' +
        'tenet_start_eval.',
      inputSchema: z.object({
        question: z
          .string()
          .min(1)
          .describe(
            'The composed escalation question: the worker report (verbatim when it surfaced options) plus the ' +
              'failure/repetition evidence and what has already been tried.',
          ),
        source_job_ids: z
          .array(z.string())
          .min(1)
          .optional()
          .describe(
            'Job ids this escalation is about, 1..N. Run context (run dir, spec, harness, scenarios, ' +
              'decomposition) is resolved from the first id — all jobs in a run share those paths. Omit when ' +
              'there is no job anchor and pass context_pointers instead.',
          ),
        context_pointers: z
          .array(z.string())
          .optional()
          .describe(
            'Explicit artifact path strings when there is no source job anchor. Paths only — the adviser reads ' +
              'the files itself.',
          ),
      }),
    },
    async ({ question, source_job_ids, context_pointers }) => {
      // One config snapshot for the whole escalation: the configured check and
      // the dispatch below read the same config, so an edit between them can
      // never produce a configured-check-then-unconfigured-dispatch mismatch.
      const config = jobManager.takeConfigSnapshot();
      if (!jobManager.isAdviserConfigured(config)) {
        return jsonResult({
          adviser_configured: false,
          message:
            'No adviser is configured. Surface this question to the user exactly as you would today: halt the ' +
            'loop and ask them. Do not wait for an adviser that will not run.',
          how_to_configure: 'tenet config --adviser-agent <claude-code|opencode|codex> --adviser-model <model>',
          note: 'The adviser is active only when both adviser_agent and adviser_model are set.',
        });
      }

      let anchorJobId: string | undefined;
      let anchorJob: Job | null | undefined;
      if (source_job_ids && source_job_ids.length > 0) {
        anchorJobId = source_job_ids[0];
        anchorJob = stateStore.getJob(anchorJobId);
        if (!anchorJob) {
          throw new Error(`source job not found: ${anchorJobId}`);
        }
      }

      const pointers = anchorJob ? resolveRunContextPointers(anchorJob) : undefined;
      // Explicit pointers stand in when the anchor resolves nothing (e.g. a
      // pathless ad-hoc job) — they are the fallback, not an addendum.
      const pointerLines =
        pointers && pointers.lines.length > 0
          ? pointers.lines
          : context_pointers && context_pointers.length > 0
            ? context_pointers
            : [];

      const anchorName =
        anchorJob && typeof anchorJob.params.name === 'string' ? anchorJob.params.name : anchorJobId;
      const name = anchorName ? `adviser escalation for ${anchorName}` : 'adviser escalation';

      const params: Record<string, unknown> = {
        name,
        prompt: buildAdviserPrompt(question, pointerLines),
        question,
        ...(source_job_ids && source_job_ids.length > 0 ? { source_job_ids } : {}),
        ...(context_pointers && context_pointers.length > 0 ? { context_pointers } : {}),
        ...(pointers?.runPath ? { run_path: pointers.runPath } : {}),
        ...(pointers?.artifactPaths ? { artifact_paths: pointers.artifactPaths } : {}),
      };

      const job = jobManager.startAdviserJob(params, config);
      return jsonResult(startJobResponse(job));
    },
  );
};
