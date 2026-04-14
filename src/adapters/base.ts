export interface AgentInvocation {
  prompt: string;
  context?: string;
  maxTurns?: number;
  workdir?: string;
  allowedTools?: string[];
  timeoutMs?: number;
}

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
