#!/usr/bin/env node

import crypto from 'node:crypto';
import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import { registerAllTools } from './tools/index.js';
import { UpgradeRequiredError, UnsupportedDbVersionError } from '../core/migrations.js';
import { DbHealthError } from '../core/state-store.js';
import { StateStore } from '../core/state-store.js';
import { AdapterRegistry } from '../adapters/index.js';
import { JobManager, jobManagerConfigForLiveReads } from '../core/job-manager.js';
import { getPackageVersion } from '../cli/version.js';

const PROJECT_PATH = process.env.TENET_PROJECT_PATH || process.cwd();

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
// No boot-time config parse: the JobManager reads .tenet/.state/config.json
// live (keep-last-good) once per dispatch, so CLI config edits apply from the
// next dispatched job without restarting this server.
const adapterRegistry = new AdapterRegistry();
const jobManager = new JobManager(
  stateStore,
  adapterRegistry,
  jobManagerConfigForLiveReads(PROJECT_PATH, serverId),
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
