import { spawn } from 'node:child_process';
import { DEFAULT_JOB_TIMEOUT_MS } from '../core/runtime-config.js';
import type { AgentAdapter, AgentInvocation, AgentResponse } from './base.js';

export class CodexAdapter implements AgentAdapter {
  public readonly name = 'codex';
  private readonly timeoutMs: number;
  private readonly extraArgs: readonly string[];

  constructor(timeoutMs = DEFAULT_JOB_TIMEOUT_MS, extraArgs: string[] = []) {
    this.timeoutMs = timeoutMs;
    this.extraArgs = extraArgs;
  }

  async invoke(invocation: AgentInvocation): Promise<AgentResponse> {
    const startedAt = Date.now();
    const prompt = invocation.context ? `${invocation.context}\n\n${invocation.prompt}` : invocation.prompt;

    return new Promise((resolve) => {
      const jobExtraArgs = invocation.extraArgs ?? [];
      const extraArgs = [...this.extraArgs, ...jobExtraArgs];
      const hasSandboxOverride = extraArgs.some((arg) =>
        arg === '--sandbox' ||
        arg === '-s' ||
        arg === '--full-auto' ||
        arg === '--dangerously-bypass-approvals-and-sandbox'
      );
      const sandboxArgs = hasSandboxOverride ? [] : ['--sandbox', 'workspace-write'];

      // Codex currently deprecates --full-auto in favor of explicit sandbox selection.
      // User/job extra args can still override the sandbox for trusted e2e jobs.
      const child = spawn('codex', ['exec', ...sandboxArgs, ...extraArgs, prompt], {
        cwd: invocation.workdir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const effectiveTimeout = invocation.timeoutMs ?? this.timeoutMs;

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, effectiveTimeout);

      child.stdout.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      child.on('close', (code) => {
        clearTimeout(timeout);
        const durationMs = Date.now() - startedAt;

        if (timedOut) {
          resolve({
            success: false,
            output: stdout,
            error: `codex invocation timed out after ${effectiveTimeout}ms`,
            durationMs,
          });
          return;
        }

        resolve({
          success: code === 0,
          output: stdout,
          error: code === 0 ? undefined : stderr || `codex exited with code ${code ?? 'unknown'}`,
          durationMs,
        });
      });

      child.on('error', (error) => {
        clearTimeout(timeout);
        resolve({
          success: false,
          output: stdout,
          error: error.message,
          durationMs: Date.now() - startedAt,
        });
      });
    });
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn('codex', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
      child.on('error', () => {
        resolve(false);
      });
      child.on('close', (code) => {
        resolve(code === 0);
      });
    });
  }
}
