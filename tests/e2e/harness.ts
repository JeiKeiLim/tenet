import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { AdapterRegistry, parseAdapterExtraArgs } from '../../src/adapters/index.js';
import { JobManager } from '../../src/core/job-manager.js';
import { StateStore } from '../../src/core/state-store.js';
import { initProject, readStateConfig } from '../../src/cli/init.js';
import { registerTenetValidateReadinessTool } from '../../src/mcp/tools/tenet-validate-readiness.js';
import { registerTenetRegisterJobsTool } from '../../src/mcp/tools/tenet-register-jobs.js';
import { registerTenetStartJobTool } from '../../src/mcp/tools/tenet-start-job.js';
import { registerTenetStartEvalTool } from '../../src/mcp/tools/tenet-start-eval.js';
import { registerTenetCompileContextTool } from '../../src/mcp/tools/tenet-compile-context.js';

// E2E harness: drive a full Tenet cycle against a real agent CLI and assert
// the canary produced a working artifact. Designed for manual invocation
// (see Makefile `e2e-*` targets) — NOT for CI.

export type CanarySpec = {
  /** Slug used for the feature (determines spec/decomposition file naming). */
  feature: string;
  /** Human-readable canary name for logs. */
  name: string;
  /** Absolute path to the canary directory containing spec.md, harness.md, jobs.json, verify.ts. */
  canaryDir: string;
  /**
   * If set, run as an agile-mode canary with this many slices. The harness
   * loads `jobs/slice-{N}.json` for each N and registers them in sequence,
   * waiting for each slice to complete before registering the next. The
   * spec.md must declare `delivery_mode: agile` and contain a `## Slice plan`
   * section. When unset, the canary runs as an autonomous-mode canary using
   * the existing single `jobs.json` file.
   */
  slices?: number;
};

export type CanaryRunOptions = {
  /**
   * Which agent adapter to use. Defaults to whatever `tenet config` says
   * the default agent is in THIS repo. Override for forcing a specific adapter.
   */
  agentName?: string;
  /** Keep the temp workdir after the run so you can inspect it. */
  keepWorkdir?: boolean;
  /** Cap the number of dev + eval cycles. Defaults to 5 (more than any canary should need). */
  maxCycles?: number;
};

export type CanaryResult = {
  canary: string;
  passed: boolean;
  workdir: string;
  durationMs: number;
  cycles: number;
  failures: string[];
  verifyDetails: string;
};

type JobDefinition = {
  id: string;
  name: string;
  type?: 'dev' | 'integration_test';
  depends_on?: string[];
  prompt: string;
  report_only?: boolean;
};

const captureHandler = <T>(register: (rt: unknown) => void): T => {
  let captured: T | undefined;
  const rt = ((_n: string, _d: unknown, h: T) => {
    captured = h;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  register(rt);
  if (!captured) throw new Error('handler not captured');
  return captured;
};

const parseResult = (r: CallToolResult): Record<string, unknown> => {
  const first = r.content[0];
  if (first.type !== 'text') throw new Error('expected text result');
  return JSON.parse(first.text);
};

/** Resolve the default agent from the REPO's own tenet config (where this harness runs). */
const resolveDefaultAgent = (repoRoot: string): string | undefined => {
  try {
    const tenetRoot = path.join(repoRoot, '.tenet');
    if (!fs.existsSync(tenetRoot)) return undefined;
    const config = readStateConfig(tenetRoot);
    return typeof config.default_agent === 'string' ? config.default_agent : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Run one canary end-to-end. Returns a result object; callers assert on .passed.
 */
export async function runCanary(spec: CanarySpec, options: CanaryRunOptions = {}): Promise<CanaryResult> {
  const failures: string[] = [];
  const startedAt = Date.now();

  // Resolve agent: explicit option → TENET_E2E_AGENT env var → default from repo config.
  // The env var lets you override for a single run (e.g. `TENET_E2E_AGENT=codex make e2e-cli`)
  // without touching the repo's own tenet config.
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const agentName =
    options.agentName ??
    (process.env.TENET_E2E_AGENT && process.env.TENET_E2E_AGENT.trim().length > 0
      ? process.env.TENET_E2E_AGENT.trim()
      : undefined) ??
    resolveDefaultAgent(repoRoot);

  if (!agentName) {
    throw new Error(
      'No agent configured. Either set TENET_E2E_AGENT=<name>, pass options.agentName, or run `tenet config --agent <name>` in the repo first.',
    );
  }

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `tenet-e2e-${spec.feature}-`));
  log(`[${spec.name}] workdir: ${workdir}`);
  log(`[${spec.name}] agent: ${agentName}`);

  // Initialize the workdir as a git repo. Real Tenet projects are git repos
  // (the dev-job preamble expects to `git commit` deliverables), and codex
  // specifically refuses to run in a non-trusted non-git directory without
  // --skip-git-repo-check. Match production shape by git-init'ing here.
  try {
    execSync('git init -q && git config user.email "tenet-e2e@local" && git config user.name "Tenet E2E" && git commit --allow-empty -m "init" -q', {
      cwd: workdir,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
  } catch (error) {
    throw new Error(
      `failed to git init e2e workdir: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let cycles = 0;
  let passed = false;
  let verifyDetails = '';

  try {
    // 1. Initialize Tenet in the workdir. Skip prompts and pre-approval — this is a
    //    throwaway environment that doesn't need host-agent permission wiring.
    initProject(workdir, { agent: agentName });
    log(`[${spec.name}] initProject done`);

    // 2. Seed canary content into .tenet/
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const specSrc = path.join(spec.canaryDir, 'spec.md');
    const harnessSrc = path.join(spec.canaryDir, 'harness.md');
    const isAgile = typeof spec.slices === 'number' && spec.slices >= 1;
    const requiredSliceFiles = isAgile
      ? Array.from({ length: spec.slices as number }, (_, i) => path.join(spec.canaryDir, 'jobs', `slice-${i + 1}.json`))
      : [];
    const jobsSrc = isAgile ? requiredSliceFiles[0] : path.join(spec.canaryDir, 'jobs.json');
    const requiredFiles = isAgile ? [specSrc, harnessSrc, ...requiredSliceFiles] : [specSrc, harnessSrc, jobsSrc];
    for (const p of requiredFiles) {
      if (!fs.existsSync(p)) throw new Error(`Canary file missing: ${p}`);
    }
    fs.writeFileSync(
      path.join(workdir, '.tenet', 'spec', `${today}-${spec.feature}.md`),
      fs.readFileSync(specSrc, 'utf8'),
    );
    fs.writeFileSync(path.join(workdir, '.tenet', 'harness', 'current.md'), fs.readFileSync(harnessSrc, 'utf8'));

    // 3. Stand up the real state store + adapter + manager.
    const store = new StateStore(workdir);
    const extraArgs = parseAdapterExtraArgs(readStateConfig(path.join(workdir, '.tenet')));
    const registry = new AdapterRegistry(extraArgs);
    const manager = new JobManager(store, registry);

    // Capture tool handlers (same pattern as Tier 1).
    const validateReadiness = captureHandler<(a: { feature: string }) => Promise<CallToolResult>>((rt) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registerTenetValidateReadinessTool(rt as any, manager, store),
    );
    const registerJobs = captureHandler<
      (a: { feature: string; jobs: JobDefinition[] }) => Promise<CallToolResult>
    >((rt) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registerTenetRegisterJobsTool(rt as any, store),
    );
    const startJob = captureHandler<
      (a: { job_id?: string; job_type?: string; params?: Record<string, unknown> }) => Promise<CallToolResult>
    >((rt) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registerTenetStartJobTool(rt as any, manager),
    );
    const startEval = captureHandler<
      (a: { job_id: string; output: Record<string, unknown>; feature?: string }) => Promise<CallToolResult>
    >((rt) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registerTenetStartEvalTool(rt as any, manager, store),
    );
    const compileContext = captureHandler<(a: { job_id: string }) => Promise<CallToolResult>>((rt) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registerTenetCompileContextTool(rt as any, store),
    );

    try {
      // 4. Readiness gate.
      log(`[${spec.name}] validate_readiness start`);
      const readinessResult = await validateReadiness({ feature: spec.feature });
      const readiness = parseResult(readinessResult);
      const readinessJobId = readiness.job_id as string;
      await manager.waitForJob(readinessJobId, null, 20 * 60 * 1000);
      const readinessJob = store.getJob(readinessJobId);
      if (readinessJob?.status !== 'completed') {
        failures.push(`readiness job did not complete: ${readinessJob?.status} (${readinessJob?.error ?? 'no error'})`);
        return finalize();
      }
      const verdict = store.getConfig(`eval_parallel_safe:${spec.feature}`);
      log(`[${spec.name}] readiness verdict: eval_parallel_safe=${verdict ?? '(not set — defaults sequential)'}`);

      // 5–6. Register jobs and drive the core loop.
      // Autonomous canary: one register call, run inner loop to all_done.
      // Agile canary: per slice, register that slice's jobs, run inner loop to all_done,
      //               capture status.md (must show "Slice N of M in progress: ..."),
      //               then advance to the next slice. Mid-slice eval failures abort.
      const maxCycles = options.maxCycles ?? 5;
      const totalSlices = isAgile ? (spec.slices as number) : 1;
      const sliceProgressLines: string[] = [];

      for (let sliceIndex = 1; sliceIndex <= totalSlices; sliceIndex++) {
        const sliceJobsSrc = isAgile
          ? path.join(spec.canaryDir, 'jobs', `slice-${sliceIndex}.json`)
          : jobsSrc;
        const jobs = JSON.parse(fs.readFileSync(sliceJobsSrc, 'utf8')) as JobDefinition[];
        const sliceLabel = isAgile ? ` slice ${sliceIndex}/${totalSlices}` : '';
        log(`[${spec.name}]${sliceLabel} register_jobs: ${jobs.length} jobs`);
        await registerJobs({ feature: spec.feature, jobs });

        // After registration, sync status files and capture the slice line for agile canaries.
        if (isAgile) {
          store.syncStatusFiles();
          const statusPath = path.join(workdir, '.tenet', 'status', 'status.md');
          if (fs.existsSync(statusPath)) {
            const content = fs.readFileSync(statusPath, 'utf8');
            const match = content.match(/^Slice \d+ of \d+ in progress:.+$/m);
            if (match) sliceProgressLines.push(match[0]);
          }
        }

        // Inner loop: drive jobs until this slice is complete.
        let sliceAborted = false;
        while (cycles < maxCycles) {
          const next = manager.continue();
          if (next.all_done) {
            log(`[${spec.name}]${sliceLabel} all jobs complete`);
            break;
          }
          if (!next.next_job) {
            failures.push(
              `${sliceLabel ? `slice ${sliceIndex}: ` : ''}no runnable job but not all_done (blocked=${next.blocked_jobs?.length ?? 0})`,
            );
            sliceAborted = true;
            break;
          }

          cycles += 1;
          const job = next.next_job;
          log(`[${spec.name}]${sliceLabel} cycle ${cycles}: dispatching ${job.params.name ?? job.id}`);

          // Compile context just to exercise the path — result isn't fed to the worker since
          // the dev job's prompt already encodes the task.
          await compileContext({ job_id: job.id });

          await startJob({ job_id: job.id });
          await manager.waitForJob(job.id, null, 25 * 60 * 1000);
          const completed = store.getJob(job.id);
          if (completed?.status !== 'completed') {
            failures.push(
              `dev job ${job.id} did not complete: ${completed?.status} (${completed?.error ?? 'no error'})`,
            );
            return finalize();
          }

          // Run evals.
          const devOutput = (store.getJobOutput(job.id) ?? {}) as Record<string, unknown>;
          const evalDispatch = await startEval({
            job_id: job.id,
            output: devOutput,
            feature: spec.feature,
          });
          const evalJobs = parseResult(evalDispatch);
          const codeJobId = evalJobs.code_critic_job_id as string;
          const testJobId = evalJobs.test_critic_job_id as string;
          const playJobId = evalJobs.playwright_eval_job_id as string;
          log(`[${spec.name}]${sliceLabel} eval dispatched (${evalJobs.execution_mode})`);

          await manager.waitForJob(codeJobId, null, 25 * 60 * 1000);
          await manager.waitForJob(testJobId, null, 25 * 60 * 1000);
          await manager.waitForJob(playJobId, null, 25 * 60 * 1000);

          const criticsStatus = [codeJobId, testJobId, playJobId].map((id) => store.getJob(id)?.status);
          const allCompleted = criticsStatus.every((s) => s === 'completed');
          if (!allCompleted) {
            failures.push(`not all critics completed: ${criticsStatus.join(', ')}`);
            return finalize();
          }
        }

        if (sliceAborted) return finalize();

        if (cycles >= maxCycles) {
          failures.push(`hit maxCycles=${maxCycles} without all_done${sliceLabel ? ` on slice ${sliceIndex}` : ''}`);
          return finalize();
        }

        // Auto-approve at the use-checkpoint: just advance to the next slice.
        // (Real Tenet pauses here for user approval; the canary acts as the
        // approving user automatically.)
        if (isAgile && sliceIndex < totalSlices) {
          log(`[${spec.name}] use-checkpoint slice ${sliceIndex}: auto-approve`);
        }
      }

      if (isAgile && sliceProgressLines.length === 0) {
        failures.push(
          'agile canary: status.md never showed a "Slice N of M in progress" line — slice progress logic is silent',
        );
      } else if (isAgile) {
        log(`[${spec.name}] captured slice progress lines: ${JSON.stringify(sliceProgressLines)}`);
      }

      // 7. Run the canary's verify script against the workdir.
      const verifyPath = path.join(spec.canaryDir, 'verify.ts');
      if (fs.existsSync(verifyPath)) {
        log(`[${spec.name}] running verify...`);
        const { verify } = (await import(verifyPath)) as {
          verify: (workdir: string) => Promise<{ passed: boolean; details: string }>;
        };
        const v = await verify(workdir);
        verifyDetails = v.details;
        if (!v.passed) {
          failures.push(`verify failed: ${v.details}`);
        } else {
          log(`[${spec.name}] verify passed: ${v.details}`);
        }
      }
    } finally {
      store.close();
    }
  } catch (error) {
    failures.push(`harness error: ${error instanceof Error ? error.message : String(error)}`);
  }

  passed = failures.length === 0;
  return finalize();

  function finalize(): CanaryResult {
    const durationMs = Date.now() - startedAt;
    const runPassed = passed && failures.length === 0;
    // Default behavior: keep the workdir on failure so maintainers can inspect
    // without having to rerun (which costs money). Explicit keepWorkdir:true
    // keeps it always; explicit keepWorkdir:false still forces cleanup.
    const shouldCleanup = options.keepWorkdir === false || (options.keepWorkdir === undefined && runPassed);
    if (shouldCleanup) {
      try {
        fs.rmSync(workdir, { recursive: true, force: true });
      } catch {
        /* noop */
      }
    } else {
      log(`[${spec.name}] keeping workdir for inspection: ${workdir}`);
    }
    return {
      canary: spec.name,
      passed: runPassed,
      workdir,
      durationMs,
      cycles,
      failures,
      verifyDetails,
    };
  }
}

/**
 * Full-pipeline agile canary: starts from a raw prompt and lets the agent
 * produce spec + decomposition (with slicing) + job definitions, then drives
 * the build loop. This validates that the skill prompts (spec phase, mockup,
 * decomposition) produce correct slicing behavior.
 *
 * Budget: ~20-30 minutes, ~$0.50-2.50 on Sonnet, ~$0.15-0.50 on Haiku.
 * Invoke via `make e2e-agile-full`.
 *
 * What this exercises that runCanary (agile) does not:
 * - Agent follows spec phase prompt → produces delivery_mode + Slice plan
 * - Agent follows decomposition prompt → produces per-slice job DAGs
 * - Agent writes structured job JSON files usable by tenet_register_jobs
 * - Each slice builds on the previous and is independently eval-passing
 *
 * What this does NOT exercise (still requires manual user-driven runs):
 * - Interactive interview phase (the prompt replaces the interview)
 * - Mockup phase (skipped for a CLI canary)
 * - Plan-checkpoint / use-checkpoint pause behavior (auto-approves)
 * - Redirect router (no redirects in the canary)
 */
export type FullPipelineSpec = {
  /** Slug used for the feature (determines spec/decomposition file naming). */
  feature: string;
  /** Human-readable canary name for logs. */
  name: string;
  /** Absolute path to the canary directory containing prompt.md, harness.md, verify.ts. */
  canaryDir: string;
  /** Expected number of slices (for verification). */
  expectedSlices: number;
};

export type FullPipelineResult = CanaryResult & {
  /** Number of slices the agent actually produced (0 if planning failed). */
  actualSlices: number;
  /** Whether the agent produced a valid agile spec. */
  specProduced: boolean;
  /** Whether the agent produced a valid decomposition. */
  decompositionProduced: boolean;
};

export async function runFullPipelineCanary(
  spec: FullPipelineSpec,
  options: CanaryRunOptions = {},
): Promise<FullPipelineResult> {
  const failures: string[] = [];
  const startedAt = Date.now();
  let cycles = 0;
  let passed = false;
  let verifyDetails = '';
  let actualSlices = 0;
  let specProduced = false;
  let decompositionProduced = false;

  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const agentName =
    options.agentName ??
    (process.env.TENET_E2E_AGENT && process.env.TENET_E2E_AGENT.trim().length > 0
      ? process.env.TENET_E2E_AGENT.trim()
      : undefined) ??
    resolveDefaultAgent(repoRoot);

  if (!agentName) {
    throw new Error(
      'No agent configured. Either set TENET_E2E_AGENT=<name>, pass options.agentName, or run `tenet config --agent <name>` in the repo first.',
    );
  }

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `tenet-e2e-fp-${spec.feature}-`));
  log(`[${spec.name}] workdir: ${workdir}`);
  log(`[${spec.name}] agent: ${agentName}`);
  log(`[${spec.name}] mode: full-pipeline agile (${spec.expectedSlices} slices expected)`);

  try {
    execSync('git init -q && git config user.email "tenet-e2e@local" && git config user.name "Tenet E2E" && git commit --allow-empty -m "init" -q', {
      cwd: workdir,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
  } catch (error) {
    throw new Error(
      `failed to git init e2e workdir: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    // 1. Init Tenet project.
    initProject(workdir, { agent: agentName });
    log(`[${spec.name}] initProject done`);

    // 2. Seed ONLY harness.md (no spec, no jobs — the agent will produce those).
    const harnessSrc = path.join(spec.canaryDir, 'harness.md');
    if (!fs.existsSync(harnessSrc)) throw new Error(`Canary file missing: ${harnessSrc}`);
    fs.writeFileSync(
      path.join(workdir, '.tenet', 'harness', 'current.md'),
      fs.readFileSync(harnessSrc, 'utf8'),
    );

    // 3. Read the raw prompt and harness content for the planning job.
    const promptSrc = path.join(spec.canaryDir, 'prompt.md');
    if (!fs.existsSync(promptSrc)) throw new Error(`Canary file missing: ${promptSrc}`);
    const rawPrompt = fs.readFileSync(promptSrc, 'utf8');
    const harnessContent = fs.readFileSync(harnessSrc, 'utf8');
    const today = new Date().toISOString().slice(0, 10);

    // 4. Stand up infrastructure.
    const store = new StateStore(workdir);
    const extraArgs = parseAdapterExtraArgs(readStateConfig(path.join(workdir, '.tenet')));
    const registry = new AdapterRegistry(extraArgs);
    const manager = new JobManager(store, registry);

    const registerJobs = captureHandler<
      (a: { feature: string; jobs: JobDefinition[] }) => Promise<CallToolResult>
    >((rt) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registerTenetRegisterJobsTool(rt as any, store),
    );
    const startJob = captureHandler<
      (a: { job_id?: string; job_type?: string; params?: Record<string, unknown> }) => Promise<CallToolResult>
    >((rt) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registerTenetStartJobTool(rt as any, manager),
    );
    const startEval = captureHandler<
      (a: { job_id: string; output: Record<string, unknown>; feature?: string }) => Promise<CallToolResult>
    >((rt) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registerTenetStartEvalTool(rt as any, manager, store),
    );
    const compileContext = captureHandler<(a: { job_id: string }) => Promise<CallToolResult>>((rt) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registerTenetCompileContextTool(rt as any, store),
    );

    try {
      // =============================================
      // PHASE 1: PLANNING — agent produces spec, decomposition, job files
      // =============================================
      const planningPrompt = [
        '## Task: Tenet Crystallization (Automated Mode)',
        '',
        'You are performing the crystallization phase for a Tenet project in automated mode',
        '(no interactive questions). Produce ALL required artifacts:',
        '',
        `1. **Spec** at \`.tenet/spec/${today}-${spec.feature}.md\`:`,
        '   - Must begin with YAML front matter: `---`\\ndelivery_mode: agile\\n`---`',
        `   - Must include a \`## Slice plan\` section with exactly ${spec.expectedSlices} slices`,
        '   - Each slice: `### Slice N: <name>` with Adds/Bundled with/User can/Out of slice',
        '   - Include acceptance criteria, tech stack, non-goals, tests',
        '',
        '2. **Decomposition** at `.tenet/decomposition/README.md` (placeholder):',
        `   - Write the full decomposition at \`.tenet/decomposition/${today}-${spec.feature}.md\``,
        '   - Must include `## Slice N: <name>` sections for each slice',
        '   - Each section lists jobs with ID, name, type, dependencies, and prompt',
        '',
        '3. **Structured job definitions** (machine-readable JSON):',
        '   - .tenet/jobs/slice-1.json — array of job objects for slice 1',
        '   - .tenet/jobs/slice-2.json — array of job objects for slice 2',
        '   Each job object: { "id", "name", "type", "depends_on", "prompt" }',
        '   Job IDs MUST use slice-{N}-{descriptor} naming convention',
        '',
        '4. **Register slice 1 jobs** using the tenet_register_jobs MCP tool:',
        `   - Read \`.tenet/jobs/slice-1.json\` and call tenet_register_jobs with feature="${spec.feature}"`,
        '   - Pass the jobs array exactly as structured in the JSON file',
        '',
        '## User Request',
        '',
        rawPrompt.trim(),
        '',
        '## Harness Contract',
        '',
        harnessContent.trim(),
      ].join('\n');

      log(`[${spec.name}] Phase 1: starting planning job`);
      const planningJobResult = await startJob({
        job_type: 'dev',
        params: {
          name: `planning-${spec.feature}`,
          prompt: planningPrompt,
        },
      });
      const planningJobParsed = parseResult(planningJobResult);
      const planningJobId = planningJobParsed.job_id as string;
      log(`[${spec.name}] planning job: ${planningJobId}`);

      await manager.waitForJob(planningJobId, null, 25 * 60 * 1000);
      const planningJob = store.getJob(planningJobId);
      if (planningJob?.status !== 'completed') {
        failures.push(
          `planning job did not complete: ${planningJob?.status} (${planningJob?.error ?? 'no error'})`,
        );
        return finalize();
      }
      cycles += 1;
      log(`[${spec.name}] planning job completed`);

      // Verify planning artifacts exist.
      const specDir = path.join(workdir, '.tenet', 'spec');
      const specFiles = fs.existsSync(specDir)
        ? fs.readdirSync(specDir).filter((f) => f.endsWith('.md'))
        : [];
      const specFile = specFiles.sort().at(-1);
      if (specFile) {
        specProduced = true;
        const specContent = fs.readFileSync(path.join(specDir, specFile), 'utf8');
        if (/delivery_mode:\s*agile/i.test(specContent)) {
          log(`[${spec.name}] spec has delivery_mode: agile`);
        } else {
          failures.push('spec missing delivery_mode: agile front matter');
        }
        const sliceMatches = specContent.match(/### Slice \d+:/g) || [];
        actualSlices = sliceMatches.length;
        log(`[${spec.name}] spec has ${actualSlices} slice(s) defined`);
      } else {
        failures.push('planning job produced no spec file');
      }

      const decompFiles = fs.existsSync(path.join(workdir, '.tenet', 'decomposition'))
        ? fs.readdirSync(path.join(workdir, '.tenet', 'decomposition')).filter((f) => f.endsWith('.md'))
        : [];
      if (decompFiles.length > 0) {
        decompositionProduced = true;
        log(`[${spec.name}] decomposition file(s): ${decompFiles.join(', ')}`);
      } else {
        failures.push('planning job produced no decomposition file');
      }

      // Read slice 2 jobs (slice 1 already registered by the planning job).
      const slice2JobsPath = path.join(workdir, '.tenet', 'jobs', 'slice-2.json');
      let slice2Jobs: JobDefinition[] = [];
      if (fs.existsSync(slice2JobsPath)) {
        try {
          slice2Jobs = JSON.parse(fs.readFileSync(slice2JobsPath, 'utf8'));
          log(`[${spec.name}] slice-2.json: ${slice2Jobs.length} job(s)`);
        } catch {
          failures.push('slice-2.json: invalid JSON');
        }
      } else {
        failures.push('planning job did not produce .tenet/jobs/slice-2.json');
      }

      // Fail fast if planning artifacts are incomplete.
      if (failures.length > 0) {
        log(`[${spec.name}] Phase 1 failures, aborting: ${failures.join('; ')}`);
        return finalize();
      }

      // =============================================
      // PHASE 2: BUILD — drive per-slice build loop
      // =============================================
      const maxCycles = options.maxCycles ?? 5;

      // Slice 1 jobs were registered by the planning job. Drive them.
      log(`[${spec.name}] Phase 2: driving slice 1 build`);
      let sliceAborted = false;
      while (cycles < maxCycles) {
        const next = manager.continue();
        if (next.all_done) {
          log(`[${spec.name}] slice 1: all jobs complete`);
          break;
        }
        if (!next.next_job) {
          failures.push(`slice 1: no runnable job but not all_done`);
          sliceAborted = true;
          break;
        }

        cycles += 1;
        const job = next.next_job;
        log(`[${spec.name}] slice 1 cycle ${cycles}: dispatching ${job.params.name ?? job.id}`);

        await compileContext({ job_id: job.id });
        await startJob({ job_id: job.id });
        await manager.waitForJob(job.id, null, 25 * 60 * 1000);
        const completed = store.getJob(job.id);
        if (completed?.status !== 'completed') {
          failures.push(`dev job ${job.id} did not complete: ${completed?.status} (${completed?.error ?? 'no error'})`);
          return finalize();
        }

        const devOutput = (store.getJobOutput(job.id) ?? {}) as Record<string, unknown>;
        const evalDispatch = await startEval({
          job_id: job.id,
          output: devOutput,
          feature: spec.feature,
        });
        const evalJobs = parseResult(evalDispatch);
        const codeJobId = evalJobs.code_critic_job_id as string;
        const testJobId = evalJobs.test_critic_job_id as string;
        const playJobId = evalJobs.playwright_eval_job_id as string;
        log(`[${spec.name}] slice 1 eval dispatched (${evalJobs.execution_mode})`);

        await manager.waitForJob(codeJobId, null, 25 * 60 * 1000);
        await manager.waitForJob(testJobId, null, 25 * 60 * 1000);
        await manager.waitForJob(playJobId, null, 25 * 60 * 1000);

        const criticsStatus = [codeJobId, testJobId, playJobId].map((id) => store.getJob(id)?.status);
        if (!criticsStatus.every((s) => s === 'completed')) {
          failures.push(`slice 1 eval: not all critics completed: ${criticsStatus.join(', ')}`);
          return finalize();
        }
      }

      if (sliceAborted) return finalize();
      if (cycles >= maxCycles) {
        failures.push(`hit maxCycles=${maxCycles} during slice 1`);
        return finalize();
      }

      // Auto-approve use-checkpoint between slices.
      log(`[${spec.name}] use-checkpoint slice 1: auto-approve, advancing to slice 2`);

      // Register slice 2 jobs.
      log(`[${spec.name}] slice 2 register_jobs: ${slice2Jobs.length} jobs`);
      await registerJobs({ feature: spec.feature, jobs: slice2Jobs });
      store.syncStatusFiles();

      // Drive slice 2.
      log(`[${spec.name}] driving slice 2 build`);
      sliceAborted = false;
      while (cycles < maxCycles) {
        const next = manager.continue();
        if (next.all_done) {
          log(`[${spec.name}] slice 2: all jobs complete`);
          break;
        }
        if (!next.next_job) {
          failures.push(`slice 2: no runnable job but not all_done`);
          sliceAborted = true;
          break;
        }

        cycles += 1;
        const job = next.next_job;
        log(`[${spec.name}] slice 2 cycle ${cycles}: dispatching ${job.params.name ?? job.id}`);

        await compileContext({ job_id: job.id });
        await startJob({ job_id: job.id });
        await manager.waitForJob(job.id, null, 25 * 60 * 1000);
        const completed = store.getJob(job.id);
        if (completed?.status !== 'completed') {
          failures.push(`dev job ${job.id} did not complete: ${completed?.status} (${completed?.error ?? 'no error'})`);
          return finalize();
        }

        const devOutput = (store.getJobOutput(job.id) ?? {}) as Record<string, unknown>;
        const evalDispatch = await startEval({
          job_id: job.id,
          output: devOutput,
          feature: spec.feature,
        });
        const evalJobs = parseResult(evalDispatch);
        const codeJobId = evalJobs.code_critic_job_id as string;
        const testJobId = evalJobs.test_critic_job_id as string;
        const playJobId = evalJobs.playwright_eval_job_id as string;
        log(`[${spec.name}] slice 2 eval dispatched (${evalJobs.execution_mode})`);

        await manager.waitForJob(codeJobId, null, 25 * 60 * 1000);
        await manager.waitForJob(testJobId, null, 25 * 60 * 1000);
        await manager.waitForJob(playJobId, null, 25 * 60 * 1000);

        const criticsStatus = [codeJobId, testJobId, playJobId].map((id) => store.getJob(id)?.status);
        if (!criticsStatus.every((s) => s === 'completed')) {
          failures.push(`slice 2 eval: not all critics completed: ${criticsStatus.join(', ')}`);
          return finalize();
        }
      }

      if (sliceAborted) return finalize();
      if (cycles >= maxCycles) {
        failures.push(`hit maxCycles=${maxCycles} during slice 2`);
        return finalize();
      }

      // =============================================
      // PHASE 3: VERIFY
      // =============================================
      const verifyPath = path.join(spec.canaryDir, 'verify.ts');
      if (fs.existsSync(verifyPath)) {
        log(`[${spec.name}] running verify...`);
        const { verify } = (await import(verifyPath)) as {
          verify: (workdir: string) => Promise<{ passed: boolean; details: string }>;
        };
        const v = await verify(workdir);
        verifyDetails = v.details;
        if (!v.passed) {
          failures.push(`verify failed: ${v.details}`);
        } else {
          log(`[${spec.name}] verify passed: ${v.details}`);
        }
      }
    } finally {
      store.close();
    }
  } catch (error) {
    failures.push(`harness error: ${error instanceof Error ? error.message : String(error)}`);
  }

  passed = failures.length === 0;
  return finalize();

  function finalize(): FullPipelineResult {
    const durationMs = Date.now() - startedAt;
    const runPassed = passed && failures.length === 0;
    const shouldCleanup = options.keepWorkdir === false || (options.keepWorkdir === undefined && runPassed);
    if (shouldCleanup) {
      try {
        fs.rmSync(workdir, { recursive: true, force: true });
      } catch {
        /* noop */
      }
    } else {
      log(`[${spec.name}] keeping workdir for inspection: ${workdir}`);
    }
    return {
      canary: spec.name,
      passed: runPassed,
      workdir,
      durationMs,
      cycles,
      failures,
      verifyDetails,
      actualSlices,
      specProduced,
      decompositionProduced,
    };
  }
}

const log = (msg: string): void => {
  // Timestamped so you can eyeball progress during a 15-min run.
  const ts = new Date().toISOString().slice(11, 19);
  // eslint-disable-next-line no-console
  console.log(`[${ts}] ${msg}`);
};
