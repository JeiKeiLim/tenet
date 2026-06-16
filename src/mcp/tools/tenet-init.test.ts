import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { registerTenetInitTool } from './tenet-init.js';

type Handler = (args: { project_path: string }) => Promise<CallToolResult>;

const tempDirs: string[] = [];

const createHandler = (): Handler => {
  let captured: Handler | undefined;
  const registerTool = ((_name: string, _def: unknown, handler: Handler) => {
    captured = handler;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  registerTenetInitTool(registerTool);
  if (!captured) throw new Error('handler not captured');
  return captured;
};

const createTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-mcp-init-test-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('tenet_init MCP tool', () => {
  it('creates lifecycle scaffold directories and templates', async () => {
    const projectPath = createTempDir();
    const handler = createHandler();

    await handler({ project_path: projectPath });

    const tenetRoot = path.join(projectPath, '.tenet');
    const expectedDirs = [
      'project',
      'project/design-components',
      'runs',
      'archive',
      'knowledge',
      'status',
      'state-snapshot',
      'interview',
      'spec',
      'harness',
      'journal',
      'steer',
      'bootstrap',
      'visuals',
    ];

    for (const dir of expectedDirs) {
      expect(fs.existsSync(path.join(tenetRoot, dir))).toBe(true);
    }

    for (const file of [
      'project/overview.md',
      'project/architecture.md',
      'project/product.md',
      'project/testing.md',
      'project/design.md',
      'harness/current.md',
      'status/status.md',
      'state-snapshot/README.md',
    ]) {
      expect(fs.existsSync(path.join(tenetRoot, file))).toBe(true);
    }

    expect(fs.readFileSync(path.join(tenetRoot, 'project', 'overview.md'), 'utf8')).toContain(
      'Bootstrap placeholder',
    );
    expect(fs.readFileSync(path.join(tenetRoot, 'harness', 'current.md'), 'utf8')).toContain(
      'Legacy Harness Compatibility',
    );
  });
});
