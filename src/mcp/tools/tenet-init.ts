import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { jsonResult, type RegisterTool } from './utils.js';

const REQUIRED_DIRS = [
  'project',
  'project/design-components',
  'runs',
  'archive',
  'knowledge',
  'status',
  'state-snapshot',
];

const TEMPLATE_FILES: Record<string, string> = {
  'project/overview.md': '# Project Overview\n\nBootstrap placeholder. Run Tenet context bootstrap before normal Tenet work.\n',
  'project/architecture.md': '# Project Architecture\n\nBootstrap placeholder. Run Tenet context bootstrap before normal Tenet work.\n',
  'project/product.md': '# Project Product\n\nBootstrap placeholder. Run Tenet context bootstrap before normal Tenet work.\n',
  'project/testing.md': '# Project Testing\n\nBootstrap placeholder. Run Tenet context bootstrap before normal Tenet work.\n',
  'project/design.md': '# Project Design\n\nBootstrap placeholder. Run Tenet context bootstrap before normal Tenet work.\n',
  'status/status.md': '# Status\n',
  'status/job-queue.md': '# Job Queue\n\n',
  'status/backlog.md': '# Backlog\n\n',
  'state-snapshot/README.md':
    '# Tenet State Snapshot\n\nPortable Tenet SQLite snapshots created by `tenet db snapshot` live here.\n',
};

const ensureFile = (filePath: string, content: string): void => {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content, 'utf8');
  }
};

export const registerTenetInitTool = (registerTool: RegisterTool): void => {
  registerTool(
    'tenet_init',
    {
      description: 'Initialize .tenet directory scaffold',
      inputSchema: z.object({
        project_path: z.string().min(1),
      }),
    },
    async ({ project_path }) => {
      const tenetRoot = path.join(project_path, '.tenet');
      fs.mkdirSync(tenetRoot, { recursive: true });

      for (const dir of REQUIRED_DIRS) {
        fs.mkdirSync(path.join(tenetRoot, dir), { recursive: true });
      }

      for (const [relativePath, content] of Object.entries(TEMPLATE_FILES)) {
        ensureFile(path.join(tenetRoot, relativePath), content);
      }

      return jsonResult({
        ok: true,
        tenet_path: tenetRoot,
      });
    },
  );
};
