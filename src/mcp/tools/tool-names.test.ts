import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TENET_MCP_TOOL_NAMES } from './tool-names.js';

// Regression guard: TENET_MCP_TOOL_NAMES is consumed by `tenet init` to
// pre-approve host-agent tool permissions. If a new tool is registered in
// index.ts without being added here, agents will still prompt for it.
describe('TENET_MCP_TOOL_NAMES drift check', () => {
  it('matches the tools wired up in src/mcp/tools/index.ts', () => {
    const currentFile = fileURLToPath(import.meta.url);
    const indexPath = path.join(path.dirname(currentFile), 'index.ts');
    const source = fs.readFileSync(indexPath, 'utf8');

    // Each wired tool appears as: safeRegister(() => registerTenetXyzTool(...))
    // Convert PascalCase slug (XyzTool) → snake_case → prefix with 'tenet_'.
    const registered = new Set<string>();
    const re = /safeRegister\(\s*\(\)\s*=>\s*registerTenet([A-Z][A-Za-z]+)Tool\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const pascal = m[1];
      const snake = pascal.replace(/([A-Z])/g, (_c, c) => `_${String(c).toLowerCase()}`).replace(/^_/, '');
      registered.add(`tenet_${snake}`);
    }

    if (registered.size === 0) {
      throw new Error('no safeRegister calls found — drift regex may be stale');
    }

    const declared = new Set<string>(TENET_MCP_TOOL_NAMES);

    for (const name of registered) {
      expect(declared.has(name), `TENET_MCP_TOOL_NAMES missing: ${name}`).toBe(true);
    }
    for (const name of declared) {
      expect(
        registered.has(name),
        `TENET_MCP_TOOL_NAMES declares tool not wired in index.ts: ${name}`,
      ).toBe(true);
    }
  });
});
