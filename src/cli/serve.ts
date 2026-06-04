import crypto from 'node:crypto';
import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import { AdapterRegistry, parseAdapterExtraArgs } from '../adapters/index.js';
import { JobManager } from '../core/job-manager.js';
import { UpgradeRequiredError, UnsupportedDbVersionError } from '../core/migrations.js';
import { DbHealthError } from '../core/state-store.js';
import { StateStore } from '../core/state-store.js';
import { registerAllTools } from '../mcp/tools/index.js';
import { readStateConfig } from './init.js';
import { getPackageVersion } from './version.js';
import path from 'node:path';

export async function startServer(projectPath: string): Promise<void> {
  process.env.TENET_PROJECT_PATH = projectPath;
  const serverId = crypto.randomUUID();

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
  try {
    stateStore = new StateStore(projectPath, { healthCheck: true });
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
  const stateConfig = readStateConfig(path.join(projectPath, '.tenet'));
  const adapterRegistry = new AdapterRegistry(parseAdapterExtraArgs(stateConfig));
  const jobManager = new JobManager(stateStore, adapterRegistry, { serverId });

  registerAllTools(server, jobManager, stateStore);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const gracefulShutdown = async (): Promise<void> => {
    await jobManager.shutdown();
    stateStore.close();
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void gracefulShutdown();
  });
  process.on('SIGTERM', () => {
    void gracefulShutdown();
  });
}
