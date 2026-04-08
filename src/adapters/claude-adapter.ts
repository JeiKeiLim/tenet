import { spawn } from 'node:child_process';
import type { AgentAdapter, AgentInvocation, AgentResponse } from './base.js';

type ClaudeJsonOutput = {
  result?: unknown;
  output?: unknown;
  content?: unknown;
  text?: unknown;
  message?: unknown;
};

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const stringifyOutput = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export class ClaudeAdapter implements AgentAdapter {
  public readonly name = 'claude-code';
  private readonly timeoutMs: number;

  constructor(timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  async invoke(invocation: AgentInvocation): Promise<AgentResponse> {
    const startedAt = Date.now();
    const prompt = invocation.context ? `${invocation.context}\n\n${invocation.prompt}` : invocation.prompt;

    return new Promise((resolve) => {
      const child = spawn(
        'claude',
        ['--print', '--output-format', 'json', prompt],
        {
          cwd: invocation.workdir,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, this.timeoutMs);

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
            error: `claude invocation timed out after ${this.timeoutMs}ms`,
            durationMs,
          });
          return;
        }

        if (code !== 0) {
          resolve({
            success: false,
            output: stdout,
            error: stderr || `claude exited with code ${code ?? 'unknown'}`,
            durationMs,
          });
          return;
        }

        try {
          const parsed = JSON.parse(stdout) as ClaudeJsonOutput;
          const content = parsed.result ?? parsed.output ?? parsed.content ?? parsed.text ?? parsed.message ?? parsed;

          resolve({
            success: true,
            output: stringifyOutput(content),
            durationMs,
          });
        } catch {
          resolve({
            success: false,
            output: stdout,
            error: 'failed to parse claude json output',
            durationMs,
          });
        }
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
      const child = spawn('claude', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
      child.on('error', () => {
        resolve(false);
      });
      child.on('close', (code) => {
        resolve(code === 0);
      });
    });
  }
}
