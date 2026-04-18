import { spawn } from 'node:child_process';
import type { AgentAdapter, AgentInvocation, AgentResponse } from './base.js';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export class OpenCodeAdapter implements AgentAdapter {
  public readonly name = 'opencode';
  private readonly timeoutMs: number;
  private readonly extraArgs: readonly string[];

  constructor(timeoutMs = DEFAULT_TIMEOUT_MS, extraArgs: string[] = []) {
    this.timeoutMs = timeoutMs;
    this.extraArgs = extraArgs;
  }

  async invoke(invocation: AgentInvocation): Promise<AgentResponse> {
    const startedAt = Date.now();
    const prompt = invocation.context ? `${invocation.context}\n\n${invocation.prompt}` : invocation.prompt;

    // Opencode's global flags (e.g. --model) must come BEFORE the `run` subcommand.
    const args = [...this.extraArgs, 'run', prompt, '--format', 'json'];
    if (invocation.workdir) {
      args.push('--dir', invocation.workdir);
    }

    return new Promise((resolve) => {
      const child = spawn('opencode', args, {
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
            error: `opencode invocation timed out after ${effectiveTimeout}ms`,
            durationMs,
          });
          return;
        }

        resolve({
          success: code === 0,
          output: stdout,
          error: code === 0 ? undefined : stderr || `opencode exited with code ${code ?? 'unknown'}`,
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
      const child = spawn('opencode', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
      child.on('error', () => {
        resolve(false);
      });
      child.on('close', (code) => {
        resolve(code === 0);
      });
    });
  }
}
