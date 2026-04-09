#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { initProject, promptAgent, writeStateConfig, readStateConfig } from './init.js';
import { showStatus } from './status.js';

const resolveProjectPath = (project?: string): string => path.resolve(project ?? process.cwd());

const ensureStateDir = (projectPath: string): string => {
  const stateDir = path.join(projectPath, '.tenet', '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  return stateDir;
};

const startBackgroundServer = (projectPath: string): void => {
  const entryPath = fileURLToPath(new URL('../../dist/mcp/index.js', import.meta.url));
  const child = fork(entryPath, [], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      TENET_PROJECT_PATH: projectPath,
    },
  });

  child.unref();

  const stateDir = ensureStateDir(projectPath);
  fs.writeFileSync(path.join(stateDir, 'server.pid'), String(child.pid), 'utf8');

  console.log(`Tenet MCP server started in background (pid ${child.pid}).`);
};

const run = async (): Promise<void> => {
  const program = new Command();

  program
    .name('tenet')
    .description('Tenet CLI')
    .version('0.1.0');

  program
    .command('init')
    .argument('[path]', 'Project path', '.')
    .option('--agent <name>', 'Default agent adapter (claude-code, opencode, codex)')
    .description('Initialize Tenet project scaffold')
    .action(async (targetPath: string, options: { agent?: string }) => {
      const projectPath = path.resolve(targetPath);

      let agent = options.agent;
      if (!agent) {
        agent = await promptAgent();
      }

      try {
        initProject(projectPath, { agent });
      } catch (error) {
        if (error instanceof Error && error.message.includes('.tenet already exists')) {
          console.warn(error.message);
          return;
        }
        throw error;
      }

      console.log(`\nInitialized Tenet scaffold at ${path.join(projectPath, '.tenet')}`);
      console.log(`Default agent: ${agent}`);
      console.log('\nNext steps:');
      console.log('- Review .tenet/harness/current.md and set project-specific constraints');
      console.log(`- Start ${agent} in this directory`);
      console.log('- To change agent later: tenet config --agent <name>');
    });

  program
    .command('serve')
    .description('Start Tenet MCP server')
    .option('--project <path>', 'Project path', '.')
    .option('--background', 'Run server in background')
    .action(async (options: { project: string; background?: boolean }) => {
      const projectPath = resolveProjectPath(options.project);
      process.env.TENET_PROJECT_PATH = projectPath;

      if (options.background) {
        startBackgroundServer(projectPath);
        return;
      }

      const { startServer } = await import('./serve.js');
      await startServer(projectPath);
    });

  program
    .command('status')
    .description('Show Tenet project status')
    .option('--project <path>', 'Project path', '.')
    .option('--all', 'Show all jobs including completed and cancelled')
    .action((options: { project: string; all?: boolean }) => {
      const projectPath = resolveProjectPath(options.project);
      showStatus(projectPath, { all: options.all });
    });

  program
    .command('config')
    .description('View or update Tenet project configuration')
    .option('--project <path>', 'Project path', '.')
    .option('--agent <name>', 'Set default agent (claude-code, opencode, codex)')
    .action(async (options: { project: string; agent?: string }) => {
      const projectPath = resolveProjectPath(options.project);
      const tenetRoot = path.join(projectPath, '.tenet');

      if (!fs.existsSync(tenetRoot)) {
        console.error('No .tenet directory found. Run `tenet init` first.');
        process.exit(1);
      }

      if (options.agent) {
        const config = readStateConfig(tenetRoot);
        config.default_agent = options.agent;
        writeStateConfig(tenetRoot, config);
        console.log(`Default agent set to: ${options.agent}`);
        return;
      }

      const config = readStateConfig(tenetRoot);
      console.log('Tenet configuration:');
      console.log(`  default_agent: ${config.default_agent ?? '(not set)'}`);
      console.log('\nTo change: tenet config --agent <name>');
    });

  await program.parseAsync(process.argv);
};

await run();
