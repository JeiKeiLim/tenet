import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { StateStore } from '../../core/state-store.js';
import { registerTenetUpdateSteerTool } from './tenet-update-steer.js';

type Handler = (args: {
  ids?: string[];
  sweep?: 'agent_context';
  status: 'acknowledged' | 'acted_on' | 'resolved';
  agent_response?: string;
}) => Promise<CallToolResult>;

const tempDirs: string[] = [];
const stores: StateStore[] = [];

const createHarness = (): { store: StateStore; handler: Handler } => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-update-steer-test-'));
  tempDirs.push(tempDir);
  const store = new StateStore(tempDir);
  stores.push(store);

  let captured: Handler | undefined;
  const registerTool = ((_name: string, _def: unknown, handler: Handler) => {
    captured = handler;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  registerTenetUpdateSteerTool(registerTool, store);
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

describe('tenet_update_steer', () => {
  it('retires a steer by id so it leaves the inbox', async () => {
    const { store, handler } = createHarness();
    const steer = store.createSteer({ class: 'directive', content: 'do the thing', source: 'user' });
    expect(store.getSteerInbox({ agentLimit: 50 }).userMessages).toHaveLength(1);

    const result = parse(await handler({ ids: [steer.id], status: 'resolved', agent_response: 'done' }));
    expect(result.updated).toBe(1);
    expect(result.status).toBe('resolved');

    expect(store.getSteerInbox({ agentLimit: 50 }).userMessages).toHaveLength(0);
  });

  it('sweeps agent-context steers but leaves user steers and directives of any source', async () => {
    const { store, handler } = createHarness();
    const ac = store.createSteer({ class: 'context', content: 'agent self-note', source: 'agent' });
    const ad = store.createSteer({ class: 'directive', content: 'agent directive', source: 'agent' });
    const uc = store.createSteer({ class: 'context', content: 'user context', source: 'user' });
    const ud = store.createSteer({ class: 'directive', content: 'user directive', source: 'user' });

    const result = parse(await handler({ sweep: 'agent_context', status: 'resolved' }));
    expect(result.swept).toBe(1);
    expect(result.ids).toEqual([ac.id]);

    const inbox = store.getSteerInbox({ agentLimit: 50 });
    expect(inbox.userMessages.map((m) => m.id).sort()).toEqual([uc.id, ud.id].sort());
    expect(inbox.agentMessages.map((m) => m.id)).toEqual([ad.id]); // agent directive survived the sweep
  });

  it('errors when no steer matches the given ids', async () => {
    const { handler } = createHarness();
    const result = await handler({ ids: ['no-such-id'], status: 'resolved' });
    expect(result.isError).toBe(true);
  });

  it('errors when both or neither of ids/sweep are provided', async () => {
    const { handler } = createHarness();
    expect((await handler({ status: 'resolved' })).isError).toBe(true); // neither
    expect((await handler({ ids: ['x'], sweep: 'agent_context', status: 'resolved' })).isError).toBe(true); // both
  });
});
