import spawn from 'cross-spawn';
import { DEFAULT_JOB_TIMEOUT_MS } from '../core/runtime-config.js';
import type { AgentAdapter, AgentInvocation, AgentResponse } from './base.js';

/**
 * opencode --format json emits a stream of NDJSON events (step_start, tool_use,
 * text, step_finish...). The assistant's actual message content lives in the
 * `text` events' `part.text`. Collapse the stream into those text parts joined
 * by newlines so downstream consumers (rubric extraction, job_result, worker
 * output) see plain text like the claude adapter produces — not raw event
 * bytes. Returns null when no text part parsed (e.g. an error banner or empty
 * stdout) so callers can fall back to the raw stream.
 */
const extractTextPartsFromNdjson = (stdout: string): string | null => {
  const parts: string[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = JSON.parse(line) as { type?: string; part?: { text?: unknown } };
      if (event.type === 'text' && typeof event.part?.text === 'string') {
        parts.push(event.part.text);
      }
    } catch {
      // Skip malformed lines — a context-limit kill can truncate the tail mid-event.
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
};

export class OpenCodeAdapter implements AgentAdapter {
  public readonly name = 'opencode';
  private readonly timeoutMs: number;
  private readonly extraArgs: readonly string[];

  constructor(timeoutMs = DEFAULT_JOB_TIMEOUT_MS, extraArgs: string[] = []) {
    this.timeoutMs = timeoutMs;
    this.extraArgs = extraArgs;
  }

  async invoke(invocation: AgentInvocation): Promise<AgentResponse> {
    const startedAt = Date.now();
    const prompt = invocation.context ? `${invocation.context}\n\n${invocation.prompt}` : invocation.prompt;

    const jobExtraArgs = invocation.extraArgs ?? [];
    // Opencode's global flags (e.g. --model) must come BEFORE the `run` subcommand.
    const args = [...this.extraArgs, ...jobExtraArgs, 'run', prompt, '--format', 'json'];
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

      child.stdout!.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });

      child.stderr!.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      child.on('close', (code) => {
        clearTimeout(timeout);
        const durationMs = Date.now() - startedAt;

        if (timedOut) {
          resolve({
            success: false,
            output: extractTextPartsFromNdjson(stdout) ?? stdout,
            error: `opencode invocation timed out after ${effectiveTimeout}ms`,
            durationMs,
          });
          return;
        }

        resolve({
          success: code === 0,
          output: extractTextPartsFromNdjson(stdout) ?? stdout,
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
