import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import type { AgentAdapter, AgentInvocation, AgentResponse } from './base.js';
import { AdapterRegistry, parseAdapterExtraArgs } from './index.js';

const spawnMock = vi.fn();

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

// Dynamic import so vi.mock takes effect before the adapters bind their spawn reference.
const { ClaudeAdapter } = await import('./claude-adapter.js');
const { OpenCodeAdapter } = await import('./opencode-adapter.js');
const { CodexAdapter } = await import('./codex-adapter.js');

class MockAdapter implements AgentAdapter {
  public readonly name: string;
  private readonly available: boolean;

  constructor(name: string, available: boolean) {
    this.name = name;
    this.available = available;
  }

  async invoke(_invocation: AgentInvocation): Promise<AgentResponse> {
    return {
      success: true,
      output: 'ok',
      durationMs: 0,
    };
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }
}

const createEmptyRegistry = (): AdapterRegistry => {
  const registry = new AdapterRegistry();
  const holder = registry as unknown as { adapters: Map<string, AgentAdapter> };
  holder.adapters.clear();
  return registry;
};

describe('AdapterRegistry', () => {
  it('registers adapter and retrieves by name', () => {
    const registry = createEmptyRegistry();
    const adapter = new MockAdapter('mock-1', true);

    registry.register(adapter);

    expect(registry.get('mock-1')).toBe(adapter);
  });

  it('lists all adapters with availability status', async () => {
    const registry = createEmptyRegistry();
    registry.register(new MockAdapter('available-adapter', true));
    registry.register(new MockAdapter('unavailable-adapter', false));

    const available = await registry.listAvailable();
    expect(available).toEqual([
      { name: 'available-adapter', available: true },
      { name: 'unavailable-adapter', available: false },
    ]);
  });

  it('returns first available adapter as default', async () => {
    const registry = createEmptyRegistry();
    registry.register(new MockAdapter('first-unavailable', false));
    const second = new MockAdapter('second-available', true);
    registry.register(second);
    registry.register(new MockAdapter('third-available', true));

    const selected = await registry.getDefault();
    expect(selected).toBe(second);
  });

  it('returns job-scoped extra args by adapter and job type', () => {
    const registry = new AdapterRegistry({
      byJobType: {
        codex: {
          playwright_eval: ['--dangerously-bypass-approvals-and-sandbox'],
        },
      },
    });

    expect(registry.getJobExtraArgs('codex', 'playwright_eval')).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
    ]);
    expect(registry.getJobExtraArgs('codex', 'dev')).toEqual([]);
    expect(registry.getJobExtraArgs('mock-adapter', 'playwright_eval')).toEqual([]);
  });

  it('throws when no adapters are available for default selection', async () => {
    const registry = createEmptyRegistry();
    registry.register(new MockAdapter('none-1', false));
    registry.register(new MockAdapter('none-2', false));

    await expect(registry.getDefault()).rejects.toThrowError(/no available adapters/);
  });
});

describe('parseAdapterExtraArgs', () => {
  it('splits whitespace-separated args', () => {
    const parsed = parseAdapterExtraArgs({
      claude_args: '--allowedTools Bash,Read,Write',
      opencode_args: '--model github-copilot/claude-opus-4-5',
      codex_args: '--sandbox danger-full-access',
      codex_args_playwright_eval: '--dangerously-bypass-approvals-and-sandbox',
    });
    expect(parsed.claude).toEqual(['--allowedTools', 'Bash,Read,Write']);
    expect(parsed.opencode).toEqual(['--model', 'github-copilot/claude-opus-4-5']);
    expect(parsed.codex).toEqual(['--sandbox', 'danger-full-access']);
    expect(parsed.byJobType?.codex?.playwright_eval).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
  });

  it('returns empty arrays for missing or empty values', () => {
    const parsed = parseAdapterExtraArgs({});
    expect(parsed.claude).toEqual([]);
    expect(parsed.opencode).toEqual([]);
    expect(parsed.codex).toEqual([]);
  });

  it('collapses extra whitespace', () => {
    const parsed = parseAdapterExtraArgs({ opencode_args: '  --model    foo   ' });
    expect(parsed.opencode).toEqual(['--model', 'foo']);
  });
});

type FakeChild = EventEmitter & {
  stdin: { write: (s: string) => void; end: () => void };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: () => void;
};

const makeFakeChild = (exitCode: number, stdout: string): FakeChild => {
  const child = new EventEmitter() as FakeChild;
  child.stdin = { write: () => undefined, end: () => undefined };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => undefined;
  setImmediate(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', exitCode);
  });
  return child;
};

describe('adapter extraArgs passthrough', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('ClaudeAdapter prepends extraArgs before --print', async () => {
    spawnMock.mockImplementation(() => makeFakeChild(0, JSON.stringify({ result: 'ok' })));

    const adapter = new ClaudeAdapter(undefined, ['--allowedTools', 'Bash,Read']);
    await adapter.invoke({ prompt: 'hi' });

    expect(spawnMock).toHaveBeenCalled();
    const argv = spawnMock.mock.calls[0][1] as string[];
    expect(argv.slice(0, 2)).toEqual(['--allowedTools', 'Bash,Read']);
    expect(argv).toContain('--print');
    // --print must come after the extra args
    expect(argv.indexOf('--print')).toBeGreaterThan(argv.indexOf('--allowedTools'));
  });

  it('OpenCodeAdapter inserts extraArgs before the run subcommand', async () => {
    spawnMock.mockImplementation(() => makeFakeChild(0, 'opencode output'));

    const adapter = new OpenCodeAdapter(undefined, ['--model', 'github-copilot/claude-opus-4-5']);
    await adapter.invoke({ prompt: 'hi' });

    expect(spawnMock).toHaveBeenCalled();
    const argv = spawnMock.mock.calls[0][1] as string[];
    expect(argv[0]).toBe('--model');
    expect(argv[1]).toBe('github-copilot/claude-opus-4-5');
    expect(argv[2]).toBe('run');
    expect(argv[3]).toBe('hi');
  });

  it('CodexAdapter inserts global and job extraArgs after the default workspace sandbox', async () => {
    spawnMock.mockImplementation(() => makeFakeChild(0, 'codex output'));

    const adapter = new CodexAdapter(undefined, ['--config', 'approval_policy="never"']);
    await adapter.invoke({ prompt: 'hi', extraArgs: ['--model', 'gpt-5-codex'] });

    expect(spawnMock).toHaveBeenCalled();
    const argv = spawnMock.mock.calls[0][1] as string[];
    expect(argv[0]).toBe('exec');
    expect(argv.slice(1, 3)).toEqual(['--sandbox', 'workspace-write']);
    expect(argv.slice(3, 5)).toEqual(['--config', 'approval_policy="never"']);
    expect(argv.slice(5, 7)).toEqual(['--model', 'gpt-5-codex']);
    expect(argv[7]).toBe('hi');
  });

  it('CodexAdapter does not add workspace sandbox when args override sandboxing', async () => {
    spawnMock.mockImplementation(() => makeFakeChild(0, 'codex output'));

    const adapter = new CodexAdapter(undefined, []);
    await adapter.invoke({ prompt: 'hi', extraArgs: ['--dangerously-bypass-approvals-and-sandbox'] });

    const argv = spawnMock.mock.calls[0][1] as string[];
    expect(argv).not.toContain('--sandbox');
    expect(argv[1]).toBe('--dangerously-bypass-approvals-and-sandbox');
  });
});
