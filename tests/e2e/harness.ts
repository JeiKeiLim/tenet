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

  // Resolve agent: explicit option → default from repo config → undefined (uses registry default).
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const agentName = options.agentName ?? resolveDefaultAgent(repoRoot);

  if (!agentName) {
    throw new Error(
      'No agent configured. Either pass options.agentName or run `tenet config --agent <name>` in the repo first.',
    );
  }

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `tenet-e2e-${spec.feature}-`));
  log(`[${spec.name}] workdir: ${workdir}`);
  log(`[${spec.name}] agent: ${agentName}`);

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
    const jobsSrc = path.join(spec.canaryDir, 'jobs.json');
    for (const p of [specSrc, harnessSrc, jobsSrc]) {
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

      // 5. Register jobs DAG.
      const jobs = JSON.parse(fs.readFileSync(jobsSrc, 'utf8')) as JobDefinition[];
      log(`[${spec.name}] register_jobs: ${jobs.length} jobs`);
      await registerJobs({ feature: spec.feature, jobs });

      // 6. Drive the core loop: continue → start → wait → result → eval → wait.
      const maxCycles = options.maxCycles ?? 5;
      while (cycles < maxCycles) {
        const next = manager.continue();
        if (next.all_done) {
          log(`[${spec.name}] all jobs complete`);
          break;
        }
        if (!next.next_job) {
          failures.push(`no runnable job but not all_done (blocked=${next.blocked_jobs?.length ?? 0})`);
          break;
        }

        cycles += 1;
        const job = next.next_job;
        log(`[${spec.name}] cycle ${cycles}: dispatching ${job.params.name ?? job.id}`);

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
        log(`[${spec.name}] eval dispatched (${evalJobs.execution_mode})`);

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

      if (cycles >= (options.maxCycles ?? 5)) {
        failures.push(`hit maxCycles=${options.maxCycles ?? 5} without all_done`);
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
    if (!options.keepWorkdir) {
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
      passed: passed && failures.length === 0,
      workdir,
      durationMs,
      cycles,
      failures,
      verifyDetails,
    };
  }
}

const log = (msg: string): void => {
  // Timestamped so you can eyeball progress during a 15-min run.
  const ts = new Date().toISOString().slice(11, 19);
  // eslint-disable-next-line no-console
  console.log(`[${ts}] ${msg}`);
};
