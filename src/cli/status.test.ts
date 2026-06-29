import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StateStore } from '../core/state-store.js';
import { showStatus } from './status.js';

const tempDirs: string[] = [];
const stores: StateStore[] = [];

const createTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-status-test-'));
  tempDirs.push(dir);
  return dir;
};

const captureLog = (fn: () => void): string => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
};

afterEach(() => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('tenet status ordering (#23)', () => {
  it('lists jobs within a status in dag_id natural order, not insertion order', () => {
    const projectPath = createTempDir();
    const store = new StateStore(projectPath);
    stores.push(store);
    // Insert in an order that is neither numeric nor lexical dag order.
    for (const dagId of ['slice-1-003', 'slice-1-001', 'slice-1-010', 'slice-1-002']) {
      store.createJob({
        type: 'dev',
        status: 'pending',
        params: { dag_id: dagId, name: `${dagId}-job` },
        retryCount: 0,
        maxRetries: 3,
      });
    }

    const out = captureLog(() => showStatus(projectPath));

    // Numeric dag order: 001 < 002 < 003 < 010 (lexical would put 010 before 003).
    expect(out.indexOf('slice-1-001:')).toBeLessThan(out.indexOf('slice-1-002:'));
    expect(out.indexOf('slice-1-002:')).toBeLessThan(out.indexOf('slice-1-003:'));
    expect(out.indexOf('slice-1-003:')).toBeLessThan(out.indexOf('slice-1-010:'));
  });

  it('groups by status priority (running before pending) even when dag_id would order otherwise', () => {
    const projectPath = createTempDir();
    const store = new StateStore(projectPath);
    stores.push(store);
    store.createJob({
      type: 'dev',
      status: 'running',
      params: { dag_id: 'p-002', name: 'runnable' },
      retryCount: 0,
      maxRetries: 3,
    });
    store.createJob({
      type: 'dev',
      status: 'pending',
      params: { dag_id: 'p-001', name: 'pending' },
      retryCount: 0,
      maxRetries: 3,
    });

    const out = captureLog(() => showStatus(projectPath));

    // Running p-002 prints before pending p-001 despite p-001 < p-002.
    expect(out.indexOf('p-002:')).toBeLessThan(out.indexOf('p-001:'));
  });
});
