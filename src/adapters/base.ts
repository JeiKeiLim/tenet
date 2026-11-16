export interface AgentInvocation {
  prompt: string;
  context?: string;
  maxTurns?: number;
  workdir?: string;
  allowedTools?: string[];
  extraArgs?: string[];
  timeoutMs?: number;
  /**
   * Model pinned by Tenet config (adviser_model / default_agent_model). Adapters
   * place it as the CLI's model flag; a pinned model REPLACES any manual --model
   * in *_args rather than appending after it — codex hard-errors on duplicate
   * model flags ("cannot be used multiple times").
   */
  model?: string;
}

/**
 * Drop every model flag (`--model X`, `--model=X`, `-m X`, `-m=X`) from an argv
 * slice, preserving everything else in order.
 */
export const stripModelFlags = (args: string[]): string[] => {
  const stripped: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--model' || arg === '-m') {
      i++; // drop the flag and its value
      continue;
    }
    if (arg.startsWith('--model=') || arg.startsWith('-m=')) {
      continue;
    }
    stripped.push(arg);
  }
  return stripped;
};

/**
 * Assemble the adapter argv args: global *_args, then job-scoped extraArgs, then
 * (when a model is pinned) a single model flag that wins over any manual --model
 * from either source. Without a pinned model the manual flags stand untouched.
 */
export const mergeExtraArgs = (
  globalArgs: readonly string[],
  jobArgs: string[],
  model?: string,
): string[] => {
  if (!model) {
    return [...globalArgs, ...jobArgs];
  }
  return [...stripModelFlags([...globalArgs, ...jobArgs]), '--model', model];
};

export interface AgentResponse {
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
}

export interface AgentAdapter {
  readonly name: string;
  invoke(invocation: AgentInvocation): Promise<AgentResponse>;
  isAvailable(): Promise<boolean>;
}
