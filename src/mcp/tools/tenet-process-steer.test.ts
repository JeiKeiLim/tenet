import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { StateStore } from '../../core/state-store.js';
import { registerTenetProcessSteerTool } from './tenet-process-steer.js';

type Handler = (args: { job_id?: string; limit?: number }) => Promise<CallToolResult>;

const tempDirs: string[] = [];
const stores: StateStore[] = [];

const createHarness = (): { store: StateStore; handler: Handler } => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-process-steer-test-'));
  tempDirs.push(tempDir);
  const store = new StateStore(tempDir);
  stores.push(store);

  let captured: Handler | undefined;
  const registerTool = ((_name: string, _def: unknown, handler: Handler) => {
    captured = handler;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  registerTenetProcessSteerTool(registerTool, store);
  if (!captured) throw new Error('handler not captured');
  return { store, handler: captured };
};

const parse = (result: CallToolResult): Record<string, unknown> => {
  const first = result.content[0];
  if (first.type !== 'text') throw new Error('expected text');
  return JSON.parse(first.text) as Record<string, unknown>;
};

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('tenet_process_steer', () => {
  it('returns user steers in full, caps agent steers, and surfaces totals + truncation', async () => {
    const { store, handler } = createHarness();
    store.createSteer({ class: 'directive', content: 'user d', source: 'user' });
    store.createSteer({ class: 'context', content: 'a1', source: 'agent' });
    store.createSteer({ class: 'context', content: 'a2', source: 'agent' });
    store.createSteer({ class: 'context', content: 'a3', source: 'agent' });

    const result = parse(await handler({ limit: 2 }));
    expect((result.user_messages as unknown[]).length).toBe(1);
    expect((result.agent_messages as unknown[]).length).toBe(2); // capped
    expect(result.total_unresolved).toEqual({ user: 1, agent: 3 }); // true counts
    expect(result.returned).toEqual({ user: 1, agent: 2 });
    expect(result.truncated).toBe(true);
  });

  it('reports truncated=false when the agent bucket fits within the limit', async () => {
    const { store, handler } = createHarness();
    store.createSteer({ class: 'context', content: 'a1', source: 'agent' });

    const result = parse(await handler({ limit: 50 }));
    expect(result.truncated).toBe(false);
    expect(result.total_unresolved).toEqual({ user: 0, agent: 1 });
  });
});
