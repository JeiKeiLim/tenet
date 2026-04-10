#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import {
  addPlaywrightToMcpJson,
  initProject,
  installPlaywrightMcp,
  isPlaywrightMcpInstalled,
  promptAgent,
  promptYesNo,
  readStateConfig,
  writeStateConfig,
} from './init.js';
import { showStatus } from './status.js';

const resolveProjectPath = (project?: string): string => path.resolve(project ?? process.cwd());

const ensureStateDir = (projectPath: string): string => {
  const stateDir = path.join(projectPath, '.tenet', '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  return stateDir;
};

const runPlaywrightCheckFlow = async (projectPath: string): Promise<void> => {
  const wantPlaywright = await promptYesNo(
    '\nUse Playwright MCP for agent-driven e2e testing? (recommended for web/UI projects)',
  );
  if (!wantPlaywright) {
    return;
  }

  if (isPlaywrightMcpInstalled()) {
    addPlaywrightToMcpJson(projectPath);
    console.log('Playwright MCP detected and added to .mcp.json.');
    return;
  }

  console.log('\nPlaywright MCP is not installed.');
  const installNow = await promptYesNo(
    'Install @playwright/mcp globally now? (runs npm install -g @playwright/mcp + npx playwright install)',
  );
  if (!installNow) {
    console.log('Skipping Playwright MCP install. Run `tenet init --upgrade` later to retry.');
    return;
  }

  const installed = installPlaywrightMcp();
  if (installed) {
    addPlaywrightToMcpJson(projectPath);
    console.log('Playwright MCP installed and added to .mcp.json.');
  } else {
    console.log('Install failed. You can install manually with:');
    console.log('  npm install -g @playwright/mcp@latest');
    console.log('  npx playwright install');
    const addAnyway = await promptYesNo('Add Playwright MCP to .mcp.json anyway?', false);
    if (addAnyway) {
      addPlaywrightToMcpJson(projectPath);
      console.log('Added Playwright MCP to .mcp.json. Install the package before running tenet.');
    }
  }
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
    .option('--upgrade', 'Upgrade existing project: overwrite skills and MCP configs, preserve user docs')
    .option('--skip-playwright-check', 'Skip the Playwright MCP availability check (useful for one-line installs)')
    .description('Initialize Tenet project scaffold')
    .action(async (targetPath: string, options: { agent?: string; upgrade?: boolean; skipPlaywrightCheck?: boolean }) => {
      const projectPath = path.resolve(targetPath);

      if (options.upgrade) {
        try {
          initProject(projectPath, { upgrade: true });
          console.log('Upgraded tenet skills and MCP configs.');
          console.log('User documents (spec, harness, interview, etc.) preserved.');
        } catch (error) {
          if (error instanceof Error) {
            console.error(error.message);
          }
          process.exit(1);
        }

        // Also run Playwright check on upgrade so existing projects can opt in
        if (!options.skipPlaywrightCheck) {
          await runPlaywrightCheckFlow(projectPath);
        }
        return;
      }

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

      // Playwright MCP setup flow
      if (!options.skipPlaywrightCheck) {
        await runPlaywrightCheckFlow(projectPath);
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
    .option('--max-retries <n>', 'Set max retries per job (default: 3)')
    .action(async (options: { project: string; agent?: string; maxRetries?: string }) => {
      const projectPath = resolveProjectPath(options.project);
      const tenetRoot = path.join(projectPath, '.tenet');

      if (!fs.existsSync(tenetRoot)) {
        console.error('No .tenet directory found. Run `tenet init` first.');
        process.exit(1);
      }

      const config = readStateConfig(tenetRoot);
      let changed = false;

      if (options.agent) {
        config.default_agent = options.agent;
        changed = true;
        console.log(`Default agent set to: ${options.agent}`);
      }

      if (options.maxRetries) {
        const n = Number.parseInt(options.maxRetries, 10);
        if (!Number.isFinite(n) || n < 0) {
          console.error('--max-retries must be a non-negative integer');
          process.exit(1);
        }
        config.max_retries = n;
        changed = true;
        console.log(`Max retries set to: ${n}`);
      }

      if (changed) {
        writeStateConfig(tenetRoot, config);
        return;
      }

      console.log('Tenet configuration:');
      console.log(`  default_agent: ${config.default_agent ?? '(not set)'}`);
      console.log(`  max_retries: ${config.max_retries ?? 3} (default: 3)`);
      console.log('\nTo change: tenet config --agent <name> --max-retries <n>');
    });

  await program.parseAsync(process.argv);
};

await run();
