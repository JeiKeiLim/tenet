#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { getPackageVersion } from './version.js';
import {
  addPlaywrightAgentConfigs,
  initProject,
  installPlaywrightMcp,
  isPlaywrightMcpInstalled,
  mergeClaudeLocalSettings,
  mergeCodexProjectTrust,
  mergeOpenCodePermission,
  previewLegacyMigration,
  promptAgent,
  promptYesNo,
  readStateConfig,
  writeStateConfig,
} from './init.js';
import type { LegacyMigrationPreview } from './init.js';
import { maybeStarNudge } from './star-nudge.js';
import {
  DEFAULT_JOB_TIMEOUT_MINUTES,
  formatMaxRetries,
  parseMaxRetries,
  parseTimeoutMinutes,
  UNLIMITED_RETRIES,
} from '../core/runtime-config.js';
import { runDbBackup, runDbCheck, runDbRestoreSnapshot, runDbSnapshot } from './db.js';
import { runCleanupCommand, type CleanupFlags } from './db-cleanup.js';
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
  console.log('Each Tenet MCP tool normally triggers an approval prompt on first use (18 tools × agents).');

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
    addPlaywrightAgentConfigs(projectPath);
    console.log('Playwright MCP detected and added to agent configs.');
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
    addPlaywrightAgentConfigs(projectPath);
    console.log('Playwright MCP installed and added to agent configs.');
  } else {
    console.log('Install failed. You can install manually with:');
    console.log('  npm install -g @playwright/mcp@latest');
    console.log('  npx playwright install');
    const addAnyway = await promptYesNo('Add Playwright MCP to agent configs anyway?', false);
    if (addAnyway) {
      addPlaywrightAgentConfigs(projectPath);
      console.log('Added Playwright MCP to agent configs. Install the package before running tenet.');
    }
  }
};

/**
 * Interactive consent prompt for the destructive legacy-document migration.
 * Shows exactly what would move and the dangling-job risk, then asks Y/N
 * (default No). Returns the user's decision.
 */
const promptMigrateLegacy = async (preview: LegacyMigrationPreview): Promise<boolean> => {
  console.log('\nTenet found legacy top-level document directories from an older layout.');
  console.log(
    `  would move into .tenet/archive/legacy-v1/: ${[...preview.dirs, ...preview.files].join(', ')}`,
  );
  console.log(
    '  This is destructive for pre-migration jobs: their artifact_paths will dangle ' +
      '(compile_context / tenet_retry_job will fail). Finish or cancel active runs first.',
  );
  return promptYesNo('\nMigrate these legacy documents now?', false);
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
    .option('--upgrade', 'Upgrade existing project: migrate DB, overwrite skills and MCP configs, preserve user docs')
    .option(
      '--migrate-legacy',
      'On upgrade, run the one-time destructive move of legacy doc dirs (spec/, interview/, …) into .tenet/archive/legacy-v1/. Required in non-interactive contexts; prompts interactively otherwise.',
    )
    .option('--skip-playwright-check', 'Skip the Playwright MCP availability check (useful for one-line installs)')
    .option('--skip-pre-approval', 'Skip the MCP tool pre-approval flow (do not touch .claude/settings.local.json, opencode.json permissions, .codex/config.toml trust)')
    .option('-y, --yes', 'Assume yes for all interactive prompts (non-interactive init, useful for CI). Does NOT auto-run the destructive --migrate-legacy move.')
    .description('Initialize Tenet project scaffold')
    .action(async (targetPath: string, options: {
      agent?: string;
      upgrade?: boolean;
      migrateLegacy?: boolean;
      skipPlaywrightCheck?: boolean;
      skipPreApproval?: boolean;
      yes?: boolean;
    }) => {
      const projectPath = path.resolve(targetPath);

      if (options.upgrade) {
        const tenetRoot = path.join(projectPath, '.tenet');
        const preview = previewLegacyMigration(tenetRoot);

        // Consent gate for the destructive legacy move:
        //  - --migrate-legacy flag → explicit opt-in (any context)
        //  - interactive TTY with work to do → Y/N prompt (default No)
        //  - otherwise (non-TTY, no flag) → skip; tell the user how to opt in
        //  -y/--yes deliberately does NOT auto-migrate (it is a broad "yes" to
        //    prompts; the destructive action must name itself).
        let migrate = false;
        if (options.migrateLegacy) {
          migrate = true;
        } else if (process.stdin.isTTY && preview.hasWork && !preview.alreadyMigrated) {
          migrate = await promptMigrateLegacy(preview);
        }

        try {
          initProject(projectPath, { upgrade: true, migrateLegacy: migrate });
          console.log('Upgraded tenet DB, skills, and MCP configs.');
          if (migrate && preview.hasWork) {
            console.log('Legacy document directories migrated to .tenet/archive/legacy-v1/; project/ docs and runtime state preserved.');
          } else if (!migrate && preview.hasWork && !preview.alreadyMigrated) {
            console.log('\nSkipped legacy document migration (destructive). To move these into .tenet/archive/legacy-v1/, re-run:');
            console.log('  tenet init --upgrade --migrate-legacy');
            console.log(`  would move: ${[...preview.dirs, ...preview.files].join(', ')}`);
          }
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

        if (process.stdin.isTTY && !options.yes) {
          await maybeStarNudge(projectPath);
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
      console.log('- Run Tenet context bootstrap to replace .tenet/project/*.md placeholders with current project doctrine');
      console.log(`- Start ${agent ?? 'your agent'} in this directory`);
      console.log('- To change agent later: tenet config --agent <name>');

      if (process.stdin.isTTY && !options.yes) {
        await maybeStarNudge(projectPath);
      }
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

  const dbCommand = program
    .command('db')
    .description('Inspect and maintain Tenet SQLite state');

  dbCommand
    .command('check')
    .description('Run read-only SQLite health checks')
    .option('--project <path>', 'Project path', '.')
    .action((options: { project: string }) => {
      const projectPath = resolveProjectPath(options.project);
      const ok = runDbCheck(projectPath);
      if (!ok) {
        process.exitCode = 1;
      }
    });

  dbCommand
    .command('backup')
    .description('Create a verified SQLite-safe backup')
    .option('--project <path>', 'Project path', '.')
    .option('--output <path>', 'Backup destination path')
    .action((options: { project: string; output?: string }) => {
      const projectPath = resolveProjectPath(options.project);
      try {
        runDbBackup(projectPath, options.output);
      } catch (error) {
        if (error instanceof Error) {
          console.error(error.message);
        }
        process.exitCode = 1;
      }
    });

  dbCommand
    .command('snapshot')
    .description('Write a Git-safe portable SQLite snapshot (gzip-compressed by default)')
    .option('--project <path>', 'Project path', '.')
    .option('--output <path>', 'Snapshot destination path')
    .option('--no-compress', 'Write a plain uncompressed SQLite snapshot (tenet.db) instead of gzip')
    .action((options: { project: string; output?: string; compress: boolean }) => {
      const projectPath = resolveProjectPath(options.project);
      try {
        runDbSnapshot(projectPath, options.output, { compress: options.compress });
      } catch (error) {
        if (error instanceof Error) {
          console.error(error.message);
        }
        process.exitCode = 1;
      }
    });

  dbCommand
    .command('restore-snapshot')
    .description('Restore live SQLite state from a portable snapshot')
    .option('--project <path>', 'Project path', '.')
    .option('--input <path>', 'Snapshot source path')
    .option('--force', 'Replace live state after removing WAL/SHM sidecars')
    .action((options: { project: string; input?: string; force?: boolean }) => {
      const projectPath = resolveProjectPath(options.project);
      try {
        runDbRestoreSnapshot(projectPath, options.input, { force: options.force === true });
      } catch (error) {
        if (error instanceof Error) {
          console.error(error.message);
        }
        process.exitCode = 1;
      }
    });

  dbCommand
    .command('cleanup')
    .description('Reclaim SQLite bloat: delete old finished jobs / activity logs, then compact')
    .option('--project <path>', 'Project path', '.')
    .option('--keep-days <n>', 'Remove finished work older than N days')
    .option('--before <date>', 'Remove finished work older than a date (YYYY-MM-DD)')
    .option('--mode <mode>', 'all (remove finished work) | events-only (trim logs, keep all results)', 'all')
    .option('--dry-run', 'Show what would happen; change nothing')
    .option('--yes', 'Skip the interactive confirmation')
    .option('--no-archive', 'Do not archive removed job records before deleting')
    .action(
      async (options: {
        project: string;
        keepDays?: string;
        before?: string;
        mode?: string;
        dryRun?: boolean;
        yes?: boolean;
        archive: boolean;
      }) => {
        const projectPath = resolveProjectPath(options.project);
        let keepDays: number | undefined;
        if (options.keepDays !== undefined) {
          keepDays = Number.parseInt(options.keepDays, 10);
          if (Number.isNaN(keepDays)) {
            console.error('--keep-days must be a whole number of days');
            process.exitCode = 1;
            return;
          }
        }
        const flags: CleanupFlags = {
          keepDays,
          before: options.before,
          mode: options.mode === 'events-only' ? 'events-only' : 'all',
          dryRun: options.dryRun === true,
          yes: options.yes === true,
          noArchive: options.archive === false,
        };
        try {
          await runCleanupCommand(projectPath, flags);
        } catch (error) {
          if (error instanceof Error) {
            console.error(error.message);
          }
          process.exitCode = 1;
        }
      },
    );

  program
    .command('config')
    .description('View or update Tenet project configuration')
    .option('--project <path>', 'Project path', '.')
    .option('--agent <name>', 'Set default agent (claude-code, opencode, codex)')
    .option('--max-retries <n|unlimited>', 'Set max retries per job (default: unlimited)')
    .option('--timeout <minutes>', `Set job timeout in minutes (default: ${DEFAULT_JOB_TIMEOUT_MINUTES})`)
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
      'Extra CLI args to pass to every codex subprocess (e.g. "--sandbox danger-full-access"). Use "" to clear.',
    )
    .option(
      '--claude-args-interaction-e2e <args>',
      'Extra CLI args to pass only to claude-code interaction-e2e critic subprocesses. Use "" to clear.',
    )
    .option(
      '--opencode-args-interaction-e2e <args>',
      'Extra CLI args to pass only to opencode interaction-e2e critic subprocesses. Use "" to clear.',
    )
    .option(
      '--codex-args-interaction-e2e <args>',
      'Extra CLI args to pass only to codex interaction-e2e critic subprocesses (e.g. "--dangerously-bypass-approvals-and-sandbox"). Use "" to clear.',
    )
    .action(async (options: {
      project: string;
      agent?: string;
      maxRetries?: string;
      timeout?: string;
      claudeArgs?: string;
      opencodeArgs?: string;
      codexArgs?: string;
      claudeArgsInteractionE2e?: string;
      opencodeArgsInteractionE2e?: string;
      codexArgsInteractionE2e?: string;
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
        const raw = options.maxRetries.trim();
        const isUnlimited = ['unlimited', 'infinite', 'inf'].includes(raw.toLowerCase());
        if (!isUnlimited && !/^\d+$/.test(raw)) {
          console.error('--max-retries must be a non-negative integer or "unlimited"');
          process.exit(1);
        }
        const n = isUnlimited ? UNLIMITED_RETRIES : Number.parseInt(raw, 10);
        config.max_retries = isUnlimited ? 'unlimited' : n;
        changed = true;
        console.log(`Max retries set to: ${formatMaxRetries(n)}`);
      }

      if (options.timeout) {
        const t = parseTimeoutMinutes(options.timeout);
        if (t === null) {
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

      const setScopedArgs = (
        optionValue: string | undefined,
        key: 'claude_args_interaction_e2e' | 'opencode_args_interaction_e2e' | 'codex_args_interaction_e2e',
      ): void => {
        if (optionValue === undefined) {
          return;
        }

        const trimmed = optionValue.trim();
        if (trimmed.length === 0) {
          delete config[key];
          console.log(`Cleared ${key}.`);
        } else {
          config[key] = trimmed;
          console.log(`${key} set to: ${trimmed}`);
        }
        changed = true;
      };

      setScopedArgs(options.claudeArgsInteractionE2e, 'claude_args_interaction_e2e');
      setScopedArgs(options.opencodeArgsInteractionE2e, 'opencode_args_interaction_e2e');
      setScopedArgs(options.codexArgsInteractionE2e, 'codex_args_interaction_e2e');

      if (changed) {
        writeStateConfig(tenetRoot, config);
        if (
          options.claudeArgs !== undefined ||
          options.opencodeArgs !== undefined ||
          options.codexArgs !== undefined ||
          options.claudeArgsInteractionE2e !== undefined ||
          options.opencodeArgsInteractionE2e !== undefined ||
          options.codexArgsInteractionE2e !== undefined
        ) {
          console.log('Restart the Tenet MCP server for adapter arg changes to take effect.');
        }
        return;
      }

      const configuredMaxRetries = config.max_retries === undefined
        ? UNLIMITED_RETRIES
        : parseMaxRetries(config.max_retries);
      const configuredTimeout = config.timeout_minutes ?? DEFAULT_JOB_TIMEOUT_MINUTES;

      console.log('Tenet configuration:');
      console.log(`  default_agent: ${config.default_agent ?? '(not set)'}`);
      console.log(`  max_retries: ${formatMaxRetries(configuredMaxRetries)} (default: unlimited)`);
      console.log(`  timeout: ${configuredTimeout} minutes (default: ${DEFAULT_JOB_TIMEOUT_MINUTES})`);
      console.log(`  claude_args: ${config.claude_args ?? '(none)'}`);
      console.log(`  opencode_args: ${config.opencode_args ?? '(none)'}`);
      console.log(`  codex_args: ${config.codex_args ?? '(none)'}`);
      console.log(`  claude_args_interaction_e2e: ${config.claude_args_interaction_e2e ?? '(none)'}`);
      console.log(`  opencode_args_interaction_e2e: ${config.opencode_args_interaction_e2e ?? '(none)'}`);
      console.log(`  codex_args_interaction_e2e: ${config.codex_args_interaction_e2e ?? '(none)'}`);
      console.log(
        '\nTo change: tenet config --agent <name> --max-retries <n|unlimited> --timeout <minutes> \\',
      );
      console.log(
        '                         --claude-args "..." --opencode-args "..." --codex-args "..." \\',
      );
      console.log(
        '                         --codex-args-interaction-e2e "..."',
      );
    });

  await program.parseAsync(process.argv);
};

await run();
