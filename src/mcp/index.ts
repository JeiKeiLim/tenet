#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import { registerAllTools } from './tools/index.js';
import { JobManager } from '../core/job-manager.js';
import { StateStore } from '../core/state-store.js';
import { AdapterRegistry, parseAdapterExtraArgs } from '../adapters/index.js';

const PROJECT_PATH = process.env.TENET_PROJECT_PATH || process.cwd();

const loadAdapterExtraArgs = (projectPath: string): ReturnType<typeof parseAdapterExtraArgs> => {
  const configPath = path.join(projectPath, '.tenet', '.state', 'config.json');
  if (!fs.existsSync(configPath)) {
    return parseAdapterExtraArgs({});
  }
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      claude_args?: string;
      opencode_args?: string;
      codex_args?: string;
    };
    return parseAdapterExtraArgs(raw);
  } catch {
    return parseAdapterExtraArgs({});
  }
};

const server = new McpServer(
  {
    name: 'tenet',
    version: '0.1.0',
  },
  {
    capabilities: {
      logging: {},
    },
  },
);

const stateStore = new StateStore(PROJECT_PATH);
const adapterRegistry = new AdapterRegistry(loadAdapterExtraArgs(PROJECT_PATH));
const jobManager = new JobManager(stateStore, adapterRegistry);

registerAllTools(server, jobManager, stateStore);

const transport = new StdioServerTransport();
await server.connect(transport);

const gracefulShutdown = async () => {
  await jobManager.shutdown();
  await stateStore.close();
  await server.close();
  process.exit(0);
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
