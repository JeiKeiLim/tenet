#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { getPackageVersion } from './version.js';
import {
  addPlaywrightToMcpJson,
  initProject,
  installPlaywrightMcp,
  isPlaywrightMcpInstalled,
  mergeClaudeLocalSettings,
  mergeCodexProjectTrust,
  mergeOpenCodePermission,
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

const runMcpPreApprovalFlow = async (
  projectPath: string,
  options: { assumeYes?: boolean },
): Promise<void> => {
  const ask = async (question: string): Promise<boolean> => {
    if (options.assumeYes) return true;
    return promptYesNo(question);
  };

  console.log('\nPre-approve Tenet MCP tools?');
  console.log('Each Tenet MCP tool normally triggers an approval prompt on first use (17 tools × agents).');

  const doClaude = await ask(
    '\nClaude Code: add Tenet tool allowlist to .claude/settings.local.json (gitignored)?',
  );
  if (doClaude) {
    const status = mergeClaudeLocalSettings(projectPath);
    switch (status) {
      case 'created':
        console.log('  ✓ .claude/settings.local.json created with Tenet tool allowlist.');
        break;
      case 'merged':
        console.log('  ✓ Merged Tenet tool entries into existing .claude/settings.local.json.');
        break;
      case 'unchanged':
        console.log('  ✓ Tenet tools already allowed in .claude/settings.local.json.');
        break;
      case 'skipped_invalid_json':
        console.log('  ⚠ .claude/settings.local.json has invalid JSON — skipped. Fix and re-run `tenet init --upgrade`.');
        break;
      default:
        break;
    }
  }

  const doOpenCode = await ask(
    'OpenCode: add permission.mcp.tenet="allow" to opencode.json?',
  );
  if (doOpenCode) {
    const status = mergeOpenCodePermission(projectPath);
    switch (status) {
      case 'created':
      case 'merged':
        console.log('  ✓ opencode.json: permission.mcp.tenet set to "allow".');
        break;
      case 'unchanged':
        console.log('  ✓ opencode.json already grants "allow" to Tenet MCP.');
        break;
      case 'skipped_invalid_json':
        console.log('  ⚠ opencode.json has invalid JSON — skipped.');
        break;
      default:
        break;
    }
  }

  const doCodex = await ask(
    'Codex: mark this project as trusted in .codex/config.toml (project-scoped, not global)?',
  );
  if (doCodex) {
    const status = mergeCodexProjectTrust(projectPath);
    switch (status) {
      case 'created':
      case 'merged':
        console.log('  ✓ .codex/config.toml: project trust_level set to "trusted".');
        break;
      case 'unchanged':
        console.log('  ✓ Project already trusted in .codex/config.toml.');
        break;
      case 'skipped_user_untrusted':
        console.log('  ⚠ .codex/config.toml has this project marked "untrusted" — respecting your choice. Edit manually if you want to change it.');
        break;
      case 'skipped_invalid_json':
        console.log('  ⚠ .codex/config.toml unreadable — skipped.');
        break;
      default:
        break;
    }
  }
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
    .version(getPackageVersion());

  program
    .command('init')
    .argument('[path]', 'Project path', '.')
    .option('--agent <name>', 'Default agent adapter (claude-code, opencode, codex)')
    .option('--upgrade', 'Upgrade existing project: overwrite skills and MCP configs, preserve user docs')
    .option('--skip-playwright-check', 'Skip the Playwright MCP availability check (useful for one-line installs)')
    .option('--skip-pre-approval', 'Skip the MCP tool pre-approval flow (do not touch .claude/settings.local.json, opencode.json permissions, .codex/config.toml trust)')
    .option('-y, --yes', 'Assume yes for all interactive prompts (non-interactive init, useful for CI)')
    .description('Initialize Tenet project scaffold')
    .action(async (targetPath: string, options: {
      agent?: string;
      upgrade?: boolean;
      skipPlaywrightCheck?: boolean;
      skipPreApproval?: boolean;
      yes?: boolean;
    }) => {
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

        if (!options.skipPreApproval) {
          await runMcpPreApprovalFlow(projectPath, { assumeYes: options.yes });
        }
        return;
      }

      let agent = options.agent;
      if (!agent && !options.yes) {
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
      if (!options.skipPlaywrightCheck && !options.yes) {
        await runPlaywrightCheckFlow(projectPath);
      }

      if (!options.skipPreApproval) {
        await runMcpPreApprovalFlow(projectPath, { assumeYes: options.yes });
      }

      console.log(`\nInitialized Tenet scaffold at ${path.join(projectPath, '.tenet')}`);
      console.log(`Default agent: ${agent ?? '(unset — run `tenet config --agent <name>`)'}`);
      console.log('\nNext steps:');
      console.log('- Review .tenet/harness/current.md and set project-specific constraints');
      console.log(`- Start ${agent ?? 'your agent'} in this directory`);
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
    .option('--timeout <minutes>', 'Set job timeout in minutes (default: 30)')
    .option(
      '--claude-args <args>',
      'Extra CLI args to pass to every claude-code subprocess (e.g. "--allowedTools Bash,Read,Write"). Use "" to clear.',
    )
    .option(
      '--opencode-args <args>',
      'Extra CLI args to pass to every opencode subprocess (e.g. "--model github-copilot/claude-opus-4-5"). Use "" to clear.',
    )
    .option(
      '--codex-args <args>',
      'Extra CLI args to pass to every codex subprocess (e.g. "--approval-mode never"). Use "" to clear.',
    )
    .action(async (options: {
      project: string;
      agent?: string;
      maxRetries?: string;
      timeout?: string;
      claudeArgs?: string;
      opencodeArgs?: string;
      codexArgs?: string;
    }) => {
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

      if (options.timeout) {
        const t = Number.parseInt(options.timeout, 10);
        if (!Number.isFinite(t) || t < 1) {
          console.error('--timeout must be a positive integer (minutes)');
          process.exit(1);
        }
        config.timeout_minutes = t;
        changed = true;
        console.log(`Job timeout set to: ${t} minutes`);
      }

      if (options.claudeArgs !== undefined) {
        const trimmed = options.claudeArgs.trim();
        if (trimmed.length === 0) {
          delete config.claude_args;
          console.log('Cleared claude_args.');
        } else {
          config.claude_args = trimmed;
          console.log(`claude_args set to: ${trimmed}`);
        }
        changed = true;
      }

      if (options.opencodeArgs !== undefined) {
        const trimmed = options.opencodeArgs.trim();
        if (trimmed.length === 0) {
          delete config.opencode_args;
          console.log('Cleared opencode_args.');
        } else {
          config.opencode_args = trimmed;
          console.log(`opencode_args set to: ${trimmed}`);
        }
        changed = true;
      }

      if (options.codexArgs !== undefined) {
        const trimmed = options.codexArgs.trim();
        if (trimmed.length === 0) {
          delete config.codex_args;
          console.log('Cleared codex_args.');
        } else {
          config.codex_args = trimmed;
          console.log(`codex_args set to: ${trimmed}`);
        }
        changed = true;
      }

      if (changed) {
        writeStateConfig(tenetRoot, config);
        if (options.claudeArgs !== undefined || options.opencodeArgs !== undefined || options.codexArgs !== undefined) {
          console.log('Restart the Tenet MCP server for adapter arg changes to take effect.');
        }
        return;
      }

      console.log('Tenet configuration:');
      console.log(`  default_agent: ${config.default_agent ?? '(not set)'}`);
      console.log(`  max_retries: ${config.max_retries ?? 3} (default: 3)`);
      console.log(`  timeout: ${config.timeout_minutes ?? 30} minutes (default: 30)`);
      console.log(`  claude_args: ${config.claude_args ?? '(none)'}`);
      console.log(`  opencode_args: ${config.opencode_args ?? '(none)'}`);
      console.log(`  codex_args: ${config.codex_args ?? '(none)'}`);
      console.log(
        '\nTo change: tenet config --agent <name> --max-retries <n> --timeout <minutes> \\',
      );
      console.log(
        '                         --claude-args "..." --opencode-args "..." --codex-args "..."',
      );
    });

  await program.parseAsync(process.argv);
};

await run();
