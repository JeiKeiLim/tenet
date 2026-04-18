import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import { AdapterRegistry, parseAdapterExtraArgs } from '../adapters/index.js';
import { JobManager } from '../core/job-manager.js';
import { StateStore } from '../core/state-store.js';
import { registerAllTools } from '../mcp/tools/index.js';
import { readStateConfig } from './init.js';
import { getPackageVersion } from './version.js';
import path from 'node:path';

export async function startServer(projectPath: string): Promise<void> {
  process.env.TENET_PROJECT_PATH = projectPath;

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

  const stateStore = new StateStore(projectPath);
  const stateConfig = readStateConfig(path.join(projectPath, '.tenet'));
  const adapterRegistry = new AdapterRegistry(parseAdapterExtraArgs(stateConfig));
  const jobManager = new JobManager(stateStore, adapterRegistry);

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
