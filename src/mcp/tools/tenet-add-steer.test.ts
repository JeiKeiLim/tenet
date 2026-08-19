import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { StateStore } from '../../core/state-store.js';
import { registerTenetAddSteerTool } from './tenet-add-steer.js';

type Handler = (args: {
  content: string;
  class?: 'context' | 'directive' | 'emergency';
  source?: 'user' | 'agent';
  affected_job_ids?: string[];
}) => Promise<CallToolResult>;

const tempDirs: string[] = [];
const stores: StateStore[] = [];

const createHarness = (): { store: StateStore; handler: Handler } => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-add-steer-test-'));
  tempDirs.push(tempDir);

  const store = new StateStore(tempDir);
  stores.push(store);

  let captured: Handler | undefined;
  const registerTool = ((_name: string, _def: unknown, handler: Handler) => {
    captured = handler;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  registerTenetAddSteerTool(registerTool, store);
  if (!captured) throw new Error('handler not captured');

  return { store, handler: captured };
};

const parseResult = (result: CallToolResult): Record<string, unknown> => {
  const first = result.content[0];
  if (first.type !== 'text') throw new Error('expected text');
  return JSON.parse(first.text);
};

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('tenet_add_steer', () => {
  it('creates a context steer that tenet_process_steer can read back', async () => {
    const { store, handler } = createHarness();

    const result = await handler({ content: 'set eval_parallel_safe=false for billing', class: 'context' });
    const parsed = parseResult(result);

    expect(parsed.steer_id).toBeTruthy();
    expect(parsed.class).toBe('context');
    expect(parsed.affected_job_ids).toEqual([]);

    const inbox = store.getSteerInbox({ agentLimit: 10 });
    expect(inbox.agentMessages).toHaveLength(1);
    expect(inbox.agentMessages[0].content).toBe('set eval_parallel_safe=false for billing');
    expect(inbox.agentMessages[0].source).toBe('agent');
  });

  it('stores an explicit directive class and user source', async () => {
    const { store, handler } = createHarness();

    await handler({ content: 'halt', class: 'emergency', source: 'user' });
    const inbox = store.getSteerInbox({ agentLimit: 10 });
    expect(inbox.userMessages).toHaveLength(1);
    expect(inbox.userMessages[0].class).toBe('emergency');
    expect(inbox.userMessages[0].source).toBe('user');
  });
});
