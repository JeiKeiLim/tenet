import { ClaudeAdapter } from './claude-adapter.js';
import { CodexAdapter } from './codex-adapter.js';
import { OpenCodeAdapter } from './opencode-adapter.js';
import type { AgentAdapter } from './base.js';

export type AdapterExtraArgs = {
  claude?: string[];
  opencode?: string[];
  codex?: string[];
};

const splitArgs = (raw: string | undefined): string[] => {
  if (!raw) return [];
  // Whitespace split is intentionally naive — see planning doc §4.
  // If users need values with embedded spaces, switch storage to a JSON array.
  return raw.trim().split(/\s+/).filter((t) => t.length > 0);
};

export const parseAdapterExtraArgs = (config: {
  claude_args?: string;
  opencode_args?: string;
  codex_args?: string;
}): AdapterExtraArgs => ({
  claude: splitArgs(config.claude_args),
  opencode: splitArgs(config.opencode_args),
  codex: splitArgs(config.codex_args),
});

export class AdapterRegistry {
  private readonly adapters: Map<string, AgentAdapter>;

  constructor(extraArgs: AdapterExtraArgs = {}) {
    this.adapters = new Map<string, AgentAdapter>();
    this.register(new ClaudeAdapter(undefined, extraArgs.claude));
    this.register(new OpenCodeAdapter(undefined, extraArgs.opencode));
    this.register(new CodexAdapter(undefined, extraArgs.codex));
  }

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  get(name: string): AgentAdapter | undefined {
    return this.adapters.get(name);
  }

  async getDefault(): Promise<AgentAdapter> {
    for (const adapter of this.adapters.values()) {
      if (await adapter.isAvailable()) {
        return adapter;
      }
    }

    throw new Error('no available adapters');
  }

  async listAvailable(): Promise<Array<{ name: string; available: boolean }>> {
    const availability = await Promise.all(
      Array.from(this.adapters.values()).map(async (adapter) => ({
        name: adapter.name,
        available: await adapter.isAvailable(),
      })),
    );

    return availability;
  }
}

export type { AgentAdapter, AgentInvocation, AgentResponse } from './base.js';
export { ClaudeAdapter } from './claude-adapter.js';
export { OpenCodeAdapter } from './opencode-adapter.js';
export { CodexAdapter } from './codex-adapter.js';
