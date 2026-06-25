import { ClaudeAdapter } from './claude-adapter.js';
import { CodexAdapter } from './codex-adapter.js';
import { OpenCodeAdapter } from './opencode-adapter.js';
import type { AgentAdapter } from './base.js';
import type { JobType } from '../types/index.js';

export type AdapterExtraArgs = {
  claude?: string[];
  opencode?: string[];
  codex?: string[];
  byJobType?: {
    claude?: Partial<Record<JobType, string[]>>;
    opencode?: Partial<Record<JobType, string[]>>;
    codex?: Partial<Record<JobType, string[]>>;
  };
};

const JOB_TYPES: JobType[] = [
  'dev',
  'eval',
  'critic_eval',
  'interaction_e2e',
  'mechanical_eval',
  'integration_test',
  'compile_context',
  'health_check',
];

const ADAPTER_NAME_TO_KEY = {
  'claude-code': 'claude',
  opencode: 'opencode',
  codex: 'codex',
} as const;

type ExtraArgsConfig = Record<string, unknown> & {
  claude_args?: string;
  opencode_args?: string;
  codex_args?: string;
};

export const splitAdapterArgs = (raw: unknown): string[] => {
  if (typeof raw !== 'string') return [];
  if (!raw) return [];
  // Whitespace split is intentionally naive — see planning doc §4.
  // If users need values with embedded spaces, switch storage to a JSON array.
  return raw.trim().split(/\s+/).filter((t) => t.length > 0);
};

const parseJobTypeArgs = (
  config: ExtraArgsConfig,
  adapterKey: 'claude' | 'opencode' | 'codex',
): Partial<Record<JobType, string[]>> => {
  const parsed: Partial<Record<JobType, string[]>> = {};
  for (const jobType of JOB_TYPES) {
    const args = splitAdapterArgs(config[`${adapterKey}_args_${jobType}`]);
    if (args.length > 0) {
      parsed[jobType] = args;
    }
  }
  return parsed;
};

export const parseAdapterExtraArgs = (config: ExtraArgsConfig): AdapterExtraArgs => ({
  claude: splitAdapterArgs(config.claude_args),
  opencode: splitAdapterArgs(config.opencode_args),
  codex: splitAdapterArgs(config.codex_args),
  byJobType: {
    claude: parseJobTypeArgs(config, 'claude'),
    opencode: parseJobTypeArgs(config, 'opencode'),
    codex: parseJobTypeArgs(config, 'codex'),
  },
});

export class AdapterRegistry {
  private readonly adapters: Map<string, AgentAdapter>;
  private readonly extraArgs: AdapterExtraArgs;

  constructor(extraArgs: AdapterExtraArgs = {}) {
    this.extraArgs = extraArgs;
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

  getJobExtraArgs(adapterName: string, jobType: JobType): string[] {
    const key = ADAPTER_NAME_TO_KEY[adapterName as keyof typeof ADAPTER_NAME_TO_KEY];
    if (!key) {
      return [];
    }

    return this.extraArgs.byJobType?.[key]?.[jobType] ?? [];
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
