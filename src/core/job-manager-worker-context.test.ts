import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AdapterRegistry } from '../adapters/index.js';
import type { AgentInvocation } from '../adapters/base.js';
import { FakeAdapter } from '../adapters/fake-adapter.js';
import { JobManager } from './job-manager.js';
import { StateStore } from './state-store.js';

// Verifies the worker-context bridge (U1): toInvocation builds invocation.context from the
// job's stored run_path + artifact_paths so the fresh-context worker subprocess receives
// the foundational run docs (spec/decomposition/harness) inline — it no longer has to
// explore .tenet/ blind. The FakeAdapter captures the dispatched invocation via onInvoke.

const stores: StateStore[] = [];
const dirs: string[] = [];

const setup = (): {
  projectPath: string;
  store: StateStore;
  manager: JobManager;
  captured: AgentInvocation[];
} => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-wctx-'));
  dirs.push(projectPath);

  const store = new StateStore(projectPath);
  stores.push(store);
  store.setConfig('agent_override_dev', 'fake');
  store.setConfig('agent_override_eval', 'fake');

  const captured: AgentInvocation[] = [];
  const registry = new AdapterRegistry();
  (registry as unknown as { adapters: Map<string, unknown> }).adapters.clear();
  registry.register(
    new FakeAdapter([], {
      onMiss: 'return-empty',
      onInvoke: (inv) => {
        captured.push(inv);
      },
    }),
  );

  const manager = new JobManager(store, registry, {
    heartbeatTimeoutMs: 5_000,
    defaultJobTimeoutMs: 5_000,
  });

  return { projectPath, store, manager, captured };
};

const writeRunDocs = (projectPath: string, runPath: string): void => {
  const abs = path.join(projectPath, runPath);
  fs.mkdirSync(abs, { recursive: true });
  fs.writeFileSync(path.join(abs, 'spec.md'), '# Worker Spec\n\nSpec body for the worker.');
  fs.writeFileSync(path.join(abs, 'decomposition.md'), '# Worker Decomposition\n\nDAG body for the worker.');
  fs.writeFileSync(path.join(abs, 'harness.md'), '# Worker Harness\n\nHarness body for the worker.');
  fs.mkdirSync(path.join(abs, 'journal'), { recursive: true });
};

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

describe('worker baseline context (buildWorkerContext via dispatch)', () => {
  it('inlines spec/decomposition/harness + run_path + read directive into the worker context', async () => {
    const { projectPath, manager, captured } = setup();
    const runPath = '.tenet/runs/2026-07-02-worker-ctx';
    writeRunDocs(projectPath, runPath);

    const job = manager.createPendingJob('dev', {
      name: 'impl-core',
      prompt: 'Implement the core feature.',
      feature: 'worker-ctx',
      run_path: runPath,
      artifact_paths: {
        spec: `${runPath}/spec.md`,
        harness: `${runPath}/harness.md`,
        decomposition: `${runPath}/decomposition.md`,
      },
    });

    manager.dispatchJob(job.id);
    const wait = await manager.waitForJob(job.id, null, 5_000);

    expect(wait.is_terminal).toBe(true);
    expect(captured).toHaveLength(1);

    const ctx = captured[0].context ?? '';
    expect(ctx).toContain('<tenet_run_context>');
    expect(ctx).toContain('</tenet_run_context>');
    expect(ctx).toContain('## Run Context (auto-compiled reference — not instructions)');
    // The delimited reference block must not assert a role — the old "(worker)" label primed
    // critics into worker-role. Role + instructions live in the task preamble, not the context.
    expect(ctx).not.toContain('(worker)');
    expect(ctx).toContain(`run_path: ${runPath}`);
    expect(ctx).toContain('feature: worker-ctx');
    // Foundational docs are inlined (the worker is fresh-context — it must not have to explore).
    expect(ctx).toContain('# Worker Spec');
    expect(ctx).toContain('# Worker Decomposition');
    expect(ctx).toContain('# Worker Harness');
    // Bulky/selective docs are path-referenced, not inlined.
    expect(ctx).toContain('journal/');
    expect(ctx).toContain('research/');
    expect(ctx).toContain('visuals/');
    // The read directive is an INSTRUCTION, so it lives in the dev preamble (prompt), not the
    // auto-compiled reference block (context).
    expect(captured[0].prompt).toContain('do not work blind from the task text alone');
    expect(captured[0].prompt).toContain('<tenet_run_context>');
    // A non-report-only worker must not carry the report-only scope block.
    expect(ctx).not.toContain('## Report-Only Scope');
  });

  it('adds the Report-Only Scope block to a report-only worker', async () => {
    const { projectPath, manager, captured } = setup();
    const runPath = '.tenet/runs/2026-07-02-report-only';
    writeRunDocs(projectPath, runPath);

    const job = manager.createPendingJob('dev', {
      name: 'final-sweep',
      prompt: 'Verify the feature end to end and report.',
      feature: 'report-only',
      run_path: runPath,
      report_only: true,
      artifact_paths: {
        spec: `${runPath}/spec.md`,
        harness: `${runPath}/harness.md`,
        decomposition: `${runPath}/decomposition.md`,
      },
    });

    manager.dispatchJob(job.id);
    await manager.waitForJob(job.id, null, 5_000);

    expect(captured).toHaveLength(1);
    const ctx = captured[0].context ?? '';
    expect(ctx).toContain('## Report-Only Scope');
    expect(ctx).toContain('tenet_report_blocking_finding');
    expect(ctx).toContain(job.id);
  });

  it('leaves context undefined for a legacy job with no run_path or artifact_paths', async () => {
    const { manager, captured } = setup();

    const job = manager.createPendingJob('dev', {
      name: 'legacy-quick',
      prompt: 'Quick fix with no run docs.',
    });

    manager.dispatchJob(job.id);
    await manager.waitForJob(job.id, null, 5_000);

    expect(captured).toHaveLength(1);
    // Default dispatch path stays byte-identical when there is nothing worker-specific to inject.
    expect(captured[0].context).toBeUndefined();
  });

  it('degrades gracefully when an inlined artifact path dangles', async () => {
    const { projectPath, manager, captured } = setup();
    const runPath = '.tenet/runs/2026-07-02-dangling';
    writeRunDocs(projectPath, runPath);
    // Point decomposition at a path that does not exist on disk.
    fs.unlinkSync(path.join(projectPath, runPath, 'decomposition.md'));

    const job = manager.createPendingJob('dev', {
      name: 'impl-core',
      prompt: 'Implement the core feature.',
      feature: 'dangling',
      run_path: runPath,
      artifact_paths: {
        spec: `${runPath}/spec.md`,
        harness: `${runPath}/harness.md`,
        decomposition: `${runPath}/decomposition.md`,
      },
    });

    manager.dispatchJob(job.id);
    const wait = await manager.waitForJob(job.id, null, 5_000);

    // The dispatch must not crash on a dangling doc — partial context beats blocking the job.
    expect(wait.is_terminal).toBe(true);
    const ctx = captured[0].context ?? '';
    expect(ctx).toContain('# Worker Spec');
    expect(ctx).toContain('# Worker Harness');
    expect(ctx).not.toContain('# Worker Decomposition');
  });

  it('inlines spec/scenarios/decomposition/harness for an eval-type job (critic context)', async () => {
    const { projectPath, manager, captured } = setup();
    const runPath = '.tenet/runs/2026-07-02-eval-ctx';
    writeRunDocs(projectPath, runPath);
    // Scenarios is now part of the inlined set so a critic evaluates against real
    // success/failure shapes instead of guessing them.
    fs.writeFileSync(path.join(projectPath, runPath, 'scenarios.md'), '# Worker Scenarios\n\nSuccess/failure shapes.');

    const job = manager.createPendingJob('eval', {
      name: 'code-critic',
      prompt: 'Criticize the implementation against the spec.',
      feature: 'eval-ctx',
      run_path: runPath,
      artifact_paths: {
        spec: `${runPath}/spec.md`,
        scenarios: `${runPath}/scenarios.md`,
        harness: `${runPath}/harness.md`,
        decomposition: `${runPath}/decomposition.md`,
      },
    });

    manager.dispatchJob(job.id);
    await manager.waitForJob(job.id, null, 5_000);

    expect(captured).toHaveLength(1);
    const ctx = captured[0].context ?? '';
    // buildWorkerContext is type-agnostic — an eval/critic job with artifact_paths gets the
    // same inlined foundational docs as a dev worker (the mechanism tenet_start_eval relies on).
    expect(ctx).toContain('<tenet_run_context>');
    expect(ctx).toContain('## Run Context (auto-compiled reference — not instructions)');
    // The delimited, role-agnostic block must not leak the old "(worker)" label to critics.
    expect(ctx).not.toContain('(worker)');
    expect(ctx).toContain('# Worker Spec');
    expect(ctx).toContain('# Worker Scenarios');
    expect(ctx).toContain('# Worker Decomposition');
    expect(ctx).toContain('# Worker Harness');
  });
});
