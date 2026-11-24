#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import { registerAllTools } from './tools/index.js';
import { UpgradeRequiredError, UnsupportedDbVersionError } from '../core/migrations.js';
import { DbHealthError } from '../core/state-store.js';
import { StateStore } from '../core/state-store.js';
import { AdapterRegistry, parseAdapterExtraArgs } from '../adapters/index.js';
import { JobManager, jobManagerConfigFromStateConfig } from '../core/job-manager.js';
import { getPackageVersion } from '../cli/version.js';

const PROJECT_PATH = process.env.TENET_PROJECT_PATH || process.cwd();

const loadRawStateConfig = (projectPath: string): Record<string, unknown> => {
  const configPath = path.join(projectPath, '.tenet', '.state', 'config.json');
  if (!fs.existsSync(configPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const server = new McpServer(
  {
    name: 'tenet',
    version: getPackageVersion(),
  },
  {
    capabilities: {
      logging: {},
    },
  },
);

let stateStore: StateStore;
const serverId = crypto.randomUUID();
try {
  stateStore = new StateStore(PROJECT_PATH, { healthCheck: true });
} catch (error) {
  if (
    error instanceof UpgradeRequiredError ||
    error instanceof UnsupportedDbVersionError ||
    error instanceof DbHealthError
  ) {
    console.error(error.message);
  }
  throw error;
}
const rawStateConfig = loadRawStateConfig(PROJECT_PATH);
const adapterRegistry = new AdapterRegistry(parseAdapterExtraArgs(rawStateConfig));
const jobManager = new JobManager(
  stateStore,
  adapterRegistry,
  jobManagerConfigFromStateConfig(rawStateConfig, serverId),
);

registerAllTools(server, jobManager, stateStore);

const transport = new StdioServerTransport();
await server.connect(transport);

const gracefulShutdown = async () => {
  await jobManager.shutdown();
  stateStore.close();
  await server.close();
  process.exit(0);
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
