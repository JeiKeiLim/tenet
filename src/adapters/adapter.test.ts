import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';
import type { AgentAdapter, AgentInvocation, AgentResponse } from './base.js';
import { AdapterRegistry, parseAdapterExtraArgs } from './index.js';

const spawnMock = vi.fn();

vi.mock('cross-spawn', () => ({
  default: (...args: unknown[]) => spawnMock(...args),
}));

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
          interaction_e2e: ['--dangerously-bypass-approvals-and-sandbox'],
        },
      },
    });

    expect(registry.getJobExtraArgs('codex', 'interaction_e2e')).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
    ]);
    expect(registry.getJobExtraArgs('codex', 'dev')).toEqual([]);
    expect(registry.getJobExtraArgs('mock-adapter', 'interaction_e2e')).toEqual([]);
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
      codex_args_interaction_e2e: '--dangerously-bypass-approvals-and-sandbox',
    });
    expect(parsed.claude).toEqual(['--allowedTools', 'Bash,Read,Write']);
    expect(parsed.opencode).toEqual(['--model', 'github-copilot/claude-opus-4-5']);
    expect(parsed.codex).toEqual(['--sandbox', 'danger-full-access']);
    expect(parsed.byJobType?.codex?.interaction_e2e).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
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

describe('OpenCodeAdapter NDJSON output collapse', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  const fixturePath = path.resolve(
    __dirname,
    '..',
    '..',
    'tests',
    'fixtures',
    'fake-agents',
    'opencode-ndjson-text-parts.json',
  );

  it('collapses the event stream into text-part contents (prose + trailing verdict)', async () => {
    const ndjson = fs.readFileSync(fixturePath, 'utf8');
    spawnMock.mockImplementation(() => makeFakeChild(0, ndjson));

    const adapter = new OpenCodeAdapter();
    const response = await adapter.invoke({ prompt: 'review this' });

    expect(response.success).toBe(true);
    expect(response.output).toContain('All 12 tests pass.');
    expect(response.output).toContain('"passed": true');
    // Raw NDJSON event framing must not leak through.
    expect(response.output).not.toContain('"type":"step_start"');
    expect(response.output).not.toContain('"type":"tool_use"');
  });

  it('joins multiple text events in stream order (real streams emit many)', async () => {
    const ndjson = fs.readFileSync(fixturePath, 'utf8');
    spawnMock.mockImplementation(() => makeFakeChild(0, ndjson));

    const adapter = new OpenCodeAdapter();
    const response = await adapter.invoke({ prompt: 'review this' });

    const zeroFindings = response.output.indexOf('zero-findings recheck');
    const verdict = response.output.indexOf('All 12 tests pass');
    expect(zeroFindings).toBeGreaterThanOrEqual(0);
    expect(verdict).toBeGreaterThan(zeroFindings);
  });

  it('end-to-end: collapsed output yields a passed rubric through extractRubricJson', async () => {
    const ndjson = fs.readFileSync(fixturePath, 'utf8');
    spawnMock.mockImplementation(() => makeFakeChild(0, ndjson));

    const adapter = new OpenCodeAdapter();
    const response = await adapter.invoke({ prompt: 'review this' });

    // The real production parser — not a mirror. Mirrors drift.
    const { extractRubricJson } = await import('../core/rubric.js');
    const parsed = extractRubricJson(response.output);
    expect(parsed).not.toBeNull();
    expect(parsed?.passed).toBe(true);
    expect(parsed?.stage).toBe('code_critic');
  });

  it('preserves the verdict even when the final line is truncated (context-limit tail)', async () => {
    const ndjson = fs.readFileSync(fixturePath, 'utf8');
    // Cut mid-event: a context-limit kill can truncate the stream before the
    // final step_finish. The text part (with the rubric) must still survive.
    const truncated = ndjson.split('\n').slice(0, -1).join('\n') + '\n{"type":"step_finish","timestamp":1785417871';
    spawnMock.mockImplementation(() => makeFakeChild(0, truncated));

    const adapter = new OpenCodeAdapter();
    const response = await adapter.invoke({ prompt: 'review this' });

    expect(response.success).toBe(true);
    expect(response.output).toContain('"passed": true');
  });

  it('falls back to raw stdout when no text part parses', async () => {
    const garbage = 'opencode: something went wrong\n{"type":"error","message":"boom"';
    spawnMock.mockImplementation(() => makeFakeChild(0, garbage));

    const adapter = new OpenCodeAdapter();
    const response = await adapter.invoke({ prompt: 'hi' });

    expect(response.output).toBe(garbage);
  });

  it('skips valid-JSON non-event lines (null, numbers) without crashing', async () => {
    const mixed = 'null\n42\n{"type":"step_start"}\n{"type":"text","part":{"text":"verdict here"}}';
    spawnMock.mockImplementation(() => makeFakeChild(0, mixed));

    const adapter = new OpenCodeAdapter();
    const response = await adapter.invoke({ prompt: 'hi' });

    expect(response.success).toBe(true);
    expect(response.output).toBe('verdict here');
  });

  it('skips text events whose part.text is not a string (shape-change guard)', async () => {
    // The typeof guard is the load-bearing line against a future opencode
    // shape change (e.g. part.text becoming an object). A truthy check would
    // push a non-string into parts and emit "[object Object]" into the output
    // that feeds rubric extraction — this test pins the guard.
    const mixed = [
      '{"type":"text","part":{"text":{"nested":true}}}',
      '{"type":"text","part":{"text":42}}',
      '{"type":"text","part":{"text":"real verdict here"}}',
    ].join('\n');
    spawnMock.mockImplementation(() => makeFakeChild(0, mixed));

    const adapter = new OpenCodeAdapter();
    const response = await adapter.invoke({ prompt: 'hi' });

    expect(response.success).toBe(true);
    expect(response.output).toBe('real verdict here');
    expect(response.output).not.toContain('[object Object]');
  });

  it('verdict survives a later text event containing real braces (extractRubricJson scan)', async () => {
    const stream = [
      '{"type":"step_start","part":{"id":"a","type":"step-start"}}',
      '{"type":"text","part":{"text":"{\\"passed\\": true, \\"stage\\": \\"code_critic\\", \\"findings\\": []}"}}',
      '{"type":"text","part":{"text":"Note: the fix touched { src/foo.ts } and { src/bar.ts } (see commit 4b8b12f)."}}',
      '{"type":"step_finish","part":{"id":"b","reason":"stop","type":"step-finish"}}',
    ].join('\n');
    spawnMock.mockImplementation(() => makeFakeChild(0, stream));

    const adapter = new OpenCodeAdapter();
    const response = await adapter.invoke({ prompt: 'review this' });

    const { extractRubricJson } = await import('../core/rubric.js');
    const parsed = extractRubricJson(response.output);
    expect(parsed).not.toBeNull();
    expect(parsed?.passed).toBe(true);
  });

  it('extractRubricJson ignores a trailing object without a passed key', async () => {
    const { extractRubricJson } = await import('../core/rubric.js');
    const output = [
      'I reviewed the diff. Verdict:',
      '{"passed": true, "stage": "code_critic", "findings": []}',
      '{"note": "this is a trailing note, not a verdict"}',
    ].join('\n');
    const parsed = extractRubricJson(output);
    expect(parsed).not.toBeNull();
    expect(parsed?.passed).toBe(true);
    expect(parsed?.stage).toBe('code_critic');
  });

  it('extractRubricJson returns null when no object has a passed key', async () => {
    const { extractRubricJson } = await import('../core/rubric.js');
    const output = 'I began my review but ran out of context before finishing.';
    expect(extractRubricJson(output)).toBeNull();
  });

  it('extractRubricJson never picks a nested passed object over the top-level verdict', async () => {
    const { extractRubricJson } = await import('../core/rubric.js');

    // t1: failing verdict + trailing tool result with nested passed:true —
    // must return the FAILING verdict, not false-green the gate.
    const t1 = [
      'V: {"passed": false, "stage": "code_critic", "findings": [{"category":"product_bug","detail":"x"}]}',
      'Tool output: {"results": [{"name": "syntax", "passed": true}]}',
    ].join('\n');
    const r1 = extractRubricJson(t1);
    expect(r1).not.toBeNull();
    expect(r1?.passed).toBe(false);
    expect(r1?.stage).toBe('code_critic');

    // t2: passing verdict + trailing object with nested passed:false —
    // must return the PASSING verdict, not false-strand the parent.
    const t2 = [
      'V: {"passed": true, "stage": "code_critic", "findings": []}',
      '{"checks": {"lint": {"passed": false}}}',
    ].join('\n');
    const r2 = extractRubricJson(t2);
    expect(r2).not.toBeNull();
    expect(r2?.passed).toBe(true);
    expect(r2?.stage).toBe('code_critic');
  });

  it('extractRubricJson handles the custom-critic shape (nested assertions in the top-level verdict)', async () => {
    const { extractRubricJson } = await import('../core/rubric.js');
    const output = JSON.stringify({
      passed: true,
      stage: 'credit_ledger_integrity',
      assertions: [
        { name: 'append_only', passed: true, evidence: 'ledger is append-only' },
        { name: 'audit_fields', passed: true, evidence: 'created_at set' },
      ],
      findings: [],
    });
    const parsed = extractRubricJson(output);
    expect(parsed).not.toBeNull();
    expect(parsed?.passed).toBe(true);
    expect(parsed?.stage).toBe('credit_ledger_integrity');
  });
});
