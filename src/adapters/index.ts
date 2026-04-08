import { ClaudeAdapter } from './claude-adapter.js';
import { CodexAdapter } from './codex-adapter.js';
import { OpenCodeAdapter } from './opencode-adapter.js';
import type { AgentAdapter } from './base.js';

export class AdapterRegistry {
  private readonly adapters: Map<string, AgentAdapter>;

  constructor() {
    this.adapters = new Map<string, AgentAdapter>();
    this.register(new ClaudeAdapter());
    this.register(new OpenCodeAdapter());
    this.register(new CodexAdapter());
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
