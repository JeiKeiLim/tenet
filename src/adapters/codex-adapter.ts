import { spawn } from 'node:child_process';
import type { AgentAdapter, AgentInvocation, AgentResponse } from './base.js';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export class CodexAdapter implements AgentAdapter {
  public readonly name = 'codex';
  private readonly timeoutMs: number;
  private readonly extraArgs: readonly string[];

  constructor(timeoutMs = DEFAULT_TIMEOUT_MS, extraArgs: string[] = []) {
    this.timeoutMs = timeoutMs;
    this.extraArgs = extraArgs;
  }

  async invoke(invocation: AgentInvocation): Promise<AgentResponse> {
    const startedAt = Date.now();
    const prompt = invocation.context ? `${invocation.context}\n\n${invocation.prompt}` : invocation.prompt;

    return new Promise((resolve) => {
      // --full-auto disables sandbox mode that Codex enables by default in non-TTY (subprocess) mode.
      // User-supplied extra args come AFTER exec subcommand and the safety flag, but BEFORE the prompt.
      const child = spawn('codex', ['exec', '--full-auto', ...this.extraArgs, prompt], {
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
