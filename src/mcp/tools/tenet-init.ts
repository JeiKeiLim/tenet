import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { jsonResult, type RegisterTool } from './utils.js';

const REQUIRED_DIRS = [
  'interview',
  'spec',
  'harness',
  'status',
  'knowledge',
  'lessons',
  'steer',
  'bootstrap',
  'visuals',
];

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

      ensureFile(path.join(tenetRoot, 'status', 'status.md'), '# Status\n');
      ensureFile(path.join(tenetRoot, 'steer', 'inbox.md'), '# Steer Inbox\n');

      return jsonResult({
        ok: true,
        tenet_path: tenetRoot,
      });
    },
  );
};
