import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { StateStore } from '../core/state-store.js';
import { TENET_MCP_TOOL_NAMES } from '../mcp/tools/tool-names.js';
import { getPackageVersion } from './version.js';

const REQUIRED_DIRS = [
  'project',
  'project/design-components',
  'runs',
  'archive',
  'interview',
  'spec',
  'harness',
  'status',
  'knowledge',
  'journal',
  'steer',
  'bootstrap',
  'visuals',
  'state-snapshot',
];

const VALID_AGENTS = ['claude-code', 'opencode', 'codex'] as const;

type InitOptions = {
  agent?: string;
  upgrade?: boolean;
};

const PORTABLE_STATE_README = `# Tenet State Snapshot

This directory is for portable Tenet SQLite snapshots that are safe to track in Git.

- Run \`tenet db snapshot\` to write \`state-snapshot/tenet.db\`.
- Run \`tenet db restore-snapshot\` to restore live runtime state from the snapshot.
- Do not track \`.tenet/.state/\`; it is the live SQLite WAL database.
`;

const TEMPLATE_FILES: Record<string, string> = {
  'project/overview.md': `# Project Overview

Bootstrap placeholder. Run Tenet context bootstrap to synthesize this from the live project before normal Tenet work.
`,
  'project/architecture.md': `# Project Architecture

Bootstrap placeholder. Run Tenet context bootstrap to synthesize current architecture, data flow, persistence, and integration contracts.
`,
  'project/product.md': `# Project Product

Bootstrap placeholder. Run Tenet context bootstrap to synthesize current user-facing behavior, stable requirements, non-goals, and product boundaries.
`,
  'project/testing.md': `# Project Testing

Bootstrap placeholder. Run Tenet context bootstrap to synthesize authoritative commands, fixtures, quality gates, and verification gaps.
`,
  'project/design.md': `# Project Design

Bootstrap placeholder. Run Tenet context bootstrap to synthesize the current user-facing experience, interaction surfaces, language, feedback, accessibility, responsiveness, and visual doctrine.
`,
  'status/status.md': `# Status

## Summary
- mode: unset
- current_job: none

## Progress
- completed: 0
- remaining: 0
- blocked: 0
`,
  'status/job-queue.md': '# Job Queue\n\n',
  'status/backlog.md': '# Backlog\n\n',
  'steer/inbox.md': '# Steer Inbox\n\n',
  'steer/processed.md': '# Steer Processed\n\n',
  'harness/current.md': `# Legacy Harness Compatibility

This file is preserved for legacy jobs that reference .tenet/harness/current.md through exact artifact_paths.
New runs must write .tenet/runs/<run-slug>/harness.md and use .tenet/project/testing.md for durable testing doctrine.

## Formatting & Linting
formatter: (configure per project)
linter: (configure per project)
enforcement: pre-commit + eval gate

## Testing Requirements
unit_test_coverage: >= 80% for new code
test_framework: (configure per project)

## Architecture Rules
- (add project-specific rules)

## Code Principles
- Prefer composition over inheritance
- Explicit over implicit
- Functions do one thing

## Danger Zones (do not modify)
- (add paths that should never be touched)

## Iron Laws
- (add invariants that must always hold)
`,
  'bootstrap/compiler.md': '# Bootstrap Compiler Configuration\n\n',
  'state-snapshot/README.md': PORTABLE_STATE_README,
};

const REQUIRED_TENET_GITIGNORE_LINES = [
  '.state/',
  '!state-snapshot/',
  '!state-snapshot/**',
  'state-snapshot/*.tmp-*',
];

const TENET_GITIGNORE_TEMPLATE = `# Live SQLite runtime state. Do not track this in Git.
.state/

# Portable snapshots created by \`tenet db snapshot\` are safe to track.
!state-snapshot/
!state-snapshot/**
state-snapshot/*.tmp-*
`;

const ensureFile = (filePath: string, content: string): void => {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content, 'utf8');
  }
};

const ensureTenetGitignore = (tenetRoot: string): void => {
  const gitignorePath = path.join(tenetRoot, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, TENET_GITIGNORE_TEMPLATE, 'utf8');
    return;
  }

  const existing = fs.readFileSync(gitignorePath, 'utf8');
  const existingLines = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const missingLines = REQUIRED_TENET_GITIGNORE_LINES.filter((line) => !existingLines.has(line));
  if (missingLines.length === 0) {
    return;
  }

  const separator = existing.endsWith('\n') ? '\n' : '\n\n';
  fs.appendFileSync(
    gitignorePath,
    `${separator}# Tenet live SQLite runtime state and portable snapshots.\n${missingLines.join('\n')}\n`,
    'utf8',
  );
};

const ensurePortableStateFiles = (tenetRoot: string): void => {
  fs.mkdirSync(path.join(tenetRoot, 'state-snapshot'), { recursive: true });
  ensureFile(path.join(tenetRoot, 'state-snapshot', 'README.md'), PORTABLE_STATE_README);
  ensureTenetGitignore(tenetRoot);
};

const ensureTemplateFiles = (tenetRoot: string): void => {
  for (const [relativePath, content] of Object.entries(TEMPLATE_FILES)) {
    ensureFile(path.join(tenetRoot, relativePath), content);
  }
};

type StateConfig = {
  default_agent?: string;
  max_retries?: number | 'unlimited';
  timeout_minutes?: number;
  opencode_args?: string;
  codex_args?: string;
  claude_args?: string;
  opencode_args_playwright_eval?: string;
  codex_args_playwright_eval?: string;
  claude_args_playwright_eval?: string;
};

export const writeStateConfig = (tenetRoot: string, config: StateConfig): void => {
  const configPath = path.join(tenetRoot, '.state', 'config.json');
  const stateDir = path.dirname(configPath);
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
};

export const readStateConfig = (tenetRoot: string): StateConfig => {
  const configPath = path.join(tenetRoot, '.state', 'config.json');
  if (!fs.existsSync(configPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) as StateConfig;
  } catch {
    return {};
  }
};

export const promptYesNo = (question: string, defaultYes = true): Promise<boolean> => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const suffix = defaultYes ? ' [Y/n]: ' : ' [y/N]: ';
    rl.question(question + suffix, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === '') {
        resolve(defaultYes);
        return;
      }
      resolve(trimmed === 'y' || trimmed === 'yes');
    });
  });
};

export const promptAgent = (): Promise<string> => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    console.log('\nWhich coding agent will you use?');
    VALID_AGENTS.forEach((name, i) => {
      console.log(`  ${i + 1}) ${name}`);
    });

    const ask = (): void => {
      rl.question('\nSelect [1-3]: ', (answer) => {
        const num = Number.parseInt(answer.trim(), 10);
        if (num >= 1 && num <= VALID_AGENTS.length) {
          rl.close();
          resolve(VALID_AGENTS[num - 1]);
          return;
        }

        const byName = answer.trim().toLowerCase();
        const match = VALID_AGENTS.find((a) => a === byName);
        if (match) {
          rl.close();
          resolve(match);
          return;
        }

        console.log('Invalid selection. Enter 1, 2, 3, or the agent name.');
        ask();
      });
    };

    ask();
  });
};

const generatedSkillMetadata = (relativeSourcePath: string): string =>
  `<!-- Generated by Tenet ${getPackageVersion()} from ${relativeSourcePath}. ` +
  'Run `tenet init --upgrade` after upgrading Tenet to refresh this copy. -->';

const injectGeneratedSkillMetadata = (content: string, relativeSourcePath: string): string => {
  const metadata = generatedSkillMetadata(relativeSourcePath);
  const frontMatter = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  if (!frontMatter) {
    return `${metadata}\n\n${content}`;
  }

  return `${content.slice(0, frontMatter[0].length)}\n${metadata}\n${content.slice(frontMatter[0].length)}`;
};

const copySkillMarkdownFile = (sourcePath: string, targetPath: string, relativeSourcePath: string): void => {
  const content = fs.readFileSync(sourcePath, 'utf8');
  const rendered = path.basename(sourcePath) === 'SKILL.md'
    ? injectGeneratedSkillMetadata(content, relativeSourcePath)
    : content;
  fs.writeFileSync(targetPath, rendered, 'utf8');
};

/**
 * Copy all skill directories (tenet, tenet-diagnose, etc.) to .claude/skills/.
 * Each skill directory gets its own subdirectory with SKILL.md.
 */
const copySkillDirs = (projectPath: string): void => {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  const skillsRoot = path.resolve(currentDir, '../../skills');

  if (!fs.existsSync(skillsRoot)) {
    return;
  }

  for (const skillDir of fs.readdirSync(skillsRoot)) {
    const sourceDir = path.join(skillsRoot, skillDir);
    if (!fs.statSync(sourceDir).isDirectory()) {
      continue;
    }

    const targetDir = path.join(projectPath, '.claude', 'skills', skillDir);
    fs.mkdirSync(targetDir, { recursive: true });

    for (const entry of fs.readdirSync(sourceDir)) {
      const entryPath = path.join(sourceDir, entry);
      const stat = fs.statSync(entryPath);

      if (entry.endsWith('.md') && stat.isFile()) {
        copySkillMarkdownFile(entryPath, path.join(targetDir, entry), `skills/${skillDir}/${entry}`);
      } else if (stat.isDirectory()) {
        // Copy subdirectories (e.g., phases/)
        const targetSubDir = path.join(targetDir, entry);
        fs.mkdirSync(targetSubDir, { recursive: true });
        for (const file of fs.readdirSync(entryPath)) {
          if (file.endsWith('.md')) {
            fs.copyFileSync(path.join(entryPath, file), path.join(targetSubDir, file));
          }
        }
      }
    }
  }
};

export function initProject(projectPath: string, options?: InitOptions): void {
  const tenetRoot = path.join(projectPath, '.tenet');

  if (options?.upgrade) {
    if (!fs.existsSync(tenetRoot)) {
      throw new Error('No .tenet directory found. Run `tenet init` first.');
    }
    // Upgrade: overwrite skills and MCP configs, preserve user docs
    upgradeProject(projectPath);
    return;
  }

  if (fs.existsSync(tenetRoot)) {
    throw new Error(`.tenet already exists at ${tenetRoot}. Use \`tenet init --upgrade\` to update skills and configs.`);
  }

  fs.mkdirSync(tenetRoot, { recursive: true });
  for (const dir of REQUIRED_DIRS) {
    fs.mkdirSync(path.join(tenetRoot, dir), { recursive: true });
  }

  fs.mkdirSync(path.join(tenetRoot, '.state'), { recursive: true });

  ensureTemplateFiles(tenetRoot);
  ensurePortableStateFiles(tenetRoot);

  if (options?.agent) {
    writeStateConfig(tenetRoot, { default_agent: options.agent });
  }

  copySkillDirs(projectPath);
  copyCodexSkill(projectPath);
  writeMcpJson(projectPath);
  mergeOpenCodeConfig(projectPath);
  writeCodexConfig(projectPath);
}

/**
 * Upgrade an existing tenet project: overwrite skills and MCP configs,
 * ensure new directories exist, but preserve all user docs and state.
 */
function upgradeProject(projectPath: string): void {
  const tenetRoot = path.join(projectPath, '.tenet');

  // Ensure any new directories exist (added in newer versions)
  for (const dir of REQUIRED_DIRS) {
    fs.mkdirSync(path.join(tenetRoot, dir), { recursive: true });
  }
  fs.mkdirSync(path.join(tenetRoot, '.state'), { recursive: true });
  ensureTemplateFiles(tenetRoot);
  ensurePortableStateFiles(tenetRoot);

  backupStateDb(tenetRoot);
  const stateStore = new StateStore(projectPath, { migrate: true });
  stateStore.close();

  // Overwrite skill files (these are tenet-owned, not user-edited)
  copySkillDirs(projectPath);
  copyCodexSkill(projectPath);

  // Re-merge MCP configs (idempotent — won't overwrite if tenet entry exists)
  writeMcpJson(projectPath);
  mergeOpenCodeConfig(projectPath);
  writeCodexConfig(projectPath);

  // Do NOT overwrite: project, harness, spec, interview, knowledge, journal, status, steer, bootstrap
  // Do NOT overwrite: .state/config.json
}

const backupStateDb = (tenetRoot: string): string | null => {
  const stateDir = path.join(tenetRoot, '.state');
  const dbPath = path.join(stateDir, 'tenet.db');
  if (!fs.existsSync(dbPath)) {
    return null;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(stateDir, `tenet.db.bak-${stamp}`);
  StateStore.backupDatabase(path.dirname(tenetRoot), backupPath);
  return backupPath;
};

/**
 * Copy tenet skill to Codex-compatible location (.agents/skills/tenet/).
 * Codex CLI discovers skills from .agents/skills/{name}/SKILL.md.
 */
const copyCodexSkill = (projectPath: string): void => {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  const skillsRoot = path.resolve(currentDir, '../../skills');

  if (!fs.existsSync(skillsRoot)) {
    return;
  }

  // Copy all skill directories to .agents/skills/
  for (const skillDir of fs.readdirSync(skillsRoot)) {
    const sourceDir = path.join(skillsRoot, skillDir);
    if (!fs.statSync(sourceDir).isDirectory()) {
      continue;
    }

    const codexSkillDir = path.join(projectPath, '.agents', 'skills', skillDir);
    fs.mkdirSync(codexSkillDir, { recursive: true });

    for (const file of fs.readdirSync(sourceDir)) {
      const filePath = path.join(sourceDir, file);
      if (file.endsWith('.md') && fs.statSync(filePath).isFile()) {
        copySkillMarkdownFile(filePath, path.join(codexSkillDir, file), `skills/${skillDir}/${file}`);
      }
    }

    // Copy subdirectories (e.g., phases/)
    for (const sub of fs.readdirSync(sourceDir)) {
      const subPath = path.join(sourceDir, sub);
      if (fs.statSync(subPath).isDirectory()) {
        const targetSubDir = path.join(codexSkillDir, sub);
        fs.mkdirSync(targetSubDir, { recursive: true });
        for (const file of fs.readdirSync(subPath)) {
          if (file.endsWith('.md')) {
            fs.copyFileSync(path.join(subPath, file), path.join(targetSubDir, file));
          }
        }
      }
    }
  }
};

const MCP_JSON_CONTENT = {
  mcpServers: {
    tenet: {
      type: 'stdio',
      command: 'tenet',
      args: ['serve'],
    },
  },
};

const PLAYWRIGHT_MCP_ENTRY = {
  type: 'stdio' as const,
  command: 'npx',
  args: ['@playwright/mcp@latest'],
};

const PLAYWRIGHT_MCP_TOOL_NAMES = [
  'browser_navigate',
  'browser_navigate_back',
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_snapshot',
  'browser_take_screenshot',
  'browser_wait_for',
  'browser_press_key',
  'browser_select_option',
  'browser_hover',
  'browser_drag',
  'browser_resize',
  'browser_tabs',
  'browser_close',
  'browser_console_messages',
  'browser_network_requests',
  'browser_evaluate',
  'browser_run_code',
  'browser_file_upload',
  'browser_handle_dialog',
];

const PLAYWRIGHT_CODEX_TOOL_APPROVAL_ENTRIES = PLAYWRIGHT_MCP_TOOL_NAMES.map(
  (name) => `[mcp_servers.playwright.tools.${name}]\napproval_mode = "approve"\n`,
).join('\n');

/**
 * Check if Playwright MCP is installed globally (or runnable via npx).
 */
export const isPlaywrightMcpInstalled = (): boolean => {
  try {
    execSync('npm list -g @playwright/mcp', {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    return true;
  } catch {
    // Fall back: check if npx can resolve it (cached)
    try {
      execSync('npx --no-install @playwright/mcp --help', {
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 5_000,
      });
      return true;
    } catch {
      return false;
    }
  }
};

/**
 * Install Playwright MCP globally and Playwright browsers.
 * Returns true on success, false on failure.
 */
export const installPlaywrightMcp = (): boolean => {
  try {
    console.log('Installing @playwright/mcp globally...');
    execSync('npm install -g @playwright/mcp@latest', {
      stdio: 'inherit',
      timeout: 180_000,
    });
    console.log('Installing Playwright browsers (this may take a minute)...');
    execSync('npx playwright install', {
      stdio: 'inherit',
      timeout: 600_000,
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Playwright MCP installation failed: ${message}`);
    return false;
  }
};

/**
 * Add Playwright MCP entry to .mcp.json without disturbing other servers.
 */
export const addPlaywrightToMcpJson = (projectPath: string): void => {
  const mcpJsonPath = path.join(projectPath, '.mcp.json');
  if (fs.existsSync(mcpJsonPath)) {
    const existing = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8')) as Record<string, unknown>;
    const servers = (existing.mcpServers ?? {}) as Record<string, unknown>;
    if (servers.playwright) {
      return;
    }
    servers.playwright = PLAYWRIGHT_MCP_ENTRY;
    existing.mcpServers = servers;
    fs.writeFileSync(mcpJsonPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
    return;
  }
  const config = { mcpServers: { playwright: PLAYWRIGHT_MCP_ENTRY } };
  fs.writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
};

export const addPlaywrightToCodexConfig = (projectPath: string): void => {
  const codexDir = path.join(projectPath, '.codex');
  const configPath = path.join(codexDir, 'config.toml');
  const serverEntry =
    `[mcp_servers.playwright]\ncommand = "npx"\nargs = ["@playwright/mcp@latest"]\n\n${PLAYWRIGHT_CODEX_TOOL_APPROVAL_ENTRIES}\n`;

  if (fs.existsSync(configPath)) {
    const existing = fs.readFileSync(configPath, 'utf8');
    if (existing.includes('[mcp_servers.playwright]')) {
      const missingTools = PLAYWRIGHT_MCP_TOOL_NAMES.filter(
        (name) => !existing.includes(`[mcp_servers.playwright.tools.${name}]`),
      );
      if (missingTools.length === 0) return;
      const toAppend =
        '\n' +
        missingTools
          .map((name) => `[mcp_servers.playwright.tools.${name}]\napproval_mode = "approve"\n`)
          .join('\n');
      fs.appendFileSync(configPath, toAppend, 'utf8');
      return;
    }

    const separator = existing.endsWith('\n') ? '\n' : '\n\n';
    fs.appendFileSync(configPath, separator + serverEntry, 'utf8');
    return;
  }

  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(configPath, serverEntry, 'utf8');
};

const writeMcpJson = (projectPath: string): void => {
  const mcpJsonPath = path.join(projectPath, '.mcp.json');
  if (fs.existsSync(mcpJsonPath)) {
    const existing = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8')) as Record<string, unknown>;
    const servers = (existing.mcpServers ?? {}) as Record<string, unknown>;
    if (servers.tenet) {
      return;
    }
    servers.tenet = MCP_JSON_CONTENT.mcpServers.tenet;
    existing.mcpServers = servers;
    fs.writeFileSync(mcpJsonPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
    return;
  }
  fs.writeFileSync(mcpJsonPath, JSON.stringify(MCP_JSON_CONTENT, null, 2) + '\n', 'utf8');
};

/**
 * Write project-local .codex/config.toml for Codex CLI MCP server discovery
 * and pre-approve all Tenet MCP tools so Codex doesn't prompt per-tool.
 *
 * Format: [mcp_servers.tenet] with command and args, plus per-tool sections:
 *   [mcp_servers.tenet.tools.tenet_continue]
 *   approval_mode = "approve"
 *
 * Note: mcp_servers (with underscore) is required — mcp-servers is silently ignored.
 */
const writeCodexConfig = (projectPath: string): void => {
  const codexDir = path.join(projectPath, '.codex');
  const configPath = path.join(codexDir, 'config.toml');

  const toolApprovalEntries = TENET_MCP_TOOL_NAMES.map(
    (name) => `[mcp_servers.tenet.tools.${name}]\napproval_mode = "approve"\n`,
  ).join('\n');

  if (fs.existsSync(configPath)) {
    const existing = fs.readFileSync(configPath, 'utf8');
    if (existing.includes('[mcp_servers.tenet]')) {
      // Merge in any tool approvals that are missing.
      const missingTools = TENET_MCP_TOOL_NAMES.filter(
        (name) => !existing.includes(`[mcp_servers.tenet.tools.${name}]`),
      );
      if (missingTools.length === 0) return;
      const toAppend =
        '\n' +
        missingTools
          .map((name) => `[mcp_servers.tenet.tools.${name}]\napproval_mode = "approve"\n`)
          .join('\n');
      fs.appendFileSync(configPath, toAppend, 'utf8');
      return;
    }
    // Append tenet MCP server config + all tool approvals
    const toAppend = `\n[mcp_servers.tenet]\ncommand = "tenet"\nargs = ["serve"]\n\n${toolApprovalEntries}\n`;
    fs.appendFileSync(configPath, toAppend, 'utf8');
    return;
  }

  fs.mkdirSync(codexDir, { recursive: true });
  const content = `[mcp_servers.tenet]\ncommand = "tenet"\nargs = ["serve"]\n\n${toolApprovalEntries}\n`;
  fs.writeFileSync(configPath, content, 'utf8');
};

const OPENCODE_MCP_ENTRY = {
  type: 'local' as const,
  command: ['tenet', 'serve'],
};

const OPENCODE_PLAYWRIGHT_MCP_ENTRY = {
  type: 'local' as const,
  command: ['npx', '@playwright/mcp@latest'],
  enabled: true,
};

const mergeOpenCodeMcpEntry = (
  projectPath: string,
  name: string,
  entry: Record<string, unknown>,
): void => {
  const configPath = path.join(projectPath, 'opencode.json');
  if (fs.existsSync(configPath)) {
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const mcp = (existing.mcp ?? {}) as Record<string, unknown>;
    if (mcp[name]) {
      return;
    }
    mcp[name] = entry;
    existing.mcp = mcp;
    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
    return;
  }
  const config = { mcp: { [name]: entry } };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
};

const mergeOpenCodeConfig = (projectPath: string): void => {
  mergeOpenCodeMcpEntry(projectPath, 'tenet', OPENCODE_MCP_ENTRY);
};

export const addPlaywrightToOpenCodeConfig = (projectPath: string): void => {
  mergeOpenCodeMcpEntry(projectPath, 'playwright', OPENCODE_PLAYWRIGHT_MCP_ENTRY);
};

export const addPlaywrightAgentConfigs = (projectPath: string): void => {
  addPlaywrightToMcpJson(projectPath);
  addPlaywrightToCodexConfig(projectPath);
  addPlaywrightToOpenCodeConfig(projectPath);
  mergeClaudePlaywrightSettings(projectPath);
  mergeOpenCodePlaywrightPermission(projectPath);
};

// --- MCP tool pre-approval helpers (Part 5) -----------------------------

export type PreApprovalStatus =
  | 'created'
  | 'merged'
  | 'unchanged'
  | 'skipped_invalid_json'
  | 'skipped_user_untrusted';

const mergeClaudeMcpSettings = (
  projectPath: string,
  serverName: string,
  allowList: string[],
): PreApprovalStatus => {
  const claudeDir = path.join(projectPath, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.local.json');

  if (!fs.existsSync(settingsPath)) {
    fs.mkdirSync(claudeDir, { recursive: true });
    const content = {
      permissions: { allow: allowList },
      enabledMcpjsonServers: [serverName],
    };
    fs.writeFileSync(settingsPath, JSON.stringify(content, null, 2) + '\n', 'utf8');
    return 'created';
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return 'skipped_invalid_json';
  }

  let changed = false;

  const permissions = (parsed.permissions ?? {}) as Record<string, unknown>;
  const existingAllow = Array.isArray(permissions.allow) ? (permissions.allow as string[]) : [];
  const allowSet = new Set(existingAllow);
  for (const entry of allowList) {
    if (!allowSet.has(entry)) {
      allowSet.add(entry);
      changed = true;
    }
  }
  permissions.allow = Array.from(allowSet);
  parsed.permissions = permissions;

  const existingServers = Array.isArray(parsed.enabledMcpjsonServers)
    ? (parsed.enabledMcpjsonServers as string[])
    : [];
  if (!existingServers.includes(serverName)) {
    existingServers.push(serverName);
    parsed.enabledMcpjsonServers = existingServers;
    changed = true;
  } else {
    parsed.enabledMcpjsonServers = existingServers;
  }

  if (!changed) {
    return 'unchanged';
  }

  fs.writeFileSync(settingsPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  return 'merged';
};

/**
 * Merge Tenet MCP tool names into .claude/settings.local.json (gitignored, user-local).
 * Never touches settings.json (which may be checked into team repos).
 *
 * Behavior:
 * - File missing → create with Tenet tool names allowed and "tenet" in enabledMcpjsonServers.
 * - File present → additively merge. Never remove existing entries.
 * - Invalid JSON → skip, return 'skipped_invalid_json'.
 */
export const mergeClaudeLocalSettings = (projectPath: string): PreApprovalStatus => {
  const allowList = TENET_MCP_TOOL_NAMES.map((name) => `mcp__tenet__${name}`);
  return mergeClaudeMcpSettings(projectPath, 'tenet', allowList);
};

export const mergeClaudePlaywrightSettings = (projectPath: string): PreApprovalStatus => {
  const allowList = PLAYWRIGHT_MCP_TOOL_NAMES.map((name) => `mcp__playwright__${name}`);
  return mergeClaudeMcpSettings(projectPath, 'playwright', allowList);
};

/**
 * Add `permission.mcp.tenet: "allow"` to opencode.json so OpenCode auto-approves
 * all tools from the Tenet MCP server. Merge is additive — never overwrites
 * existing permission keys.
 */
const mergeOpenCodeMcpPermission = (projectPath: string, serverName: string): PreApprovalStatus => {
  const configPath = path.join(projectPath, 'opencode.json');
  if (!fs.existsSync(configPath)) {
    // opencode.json should have been created by initProject's MCP discovery step.
    // Create a minimal one with just the permission block if it's missing.
    const content = { permission: { mcp: { [serverName]: 'allow' } } };
    fs.writeFileSync(configPath, JSON.stringify(content, null, 2) + '\n', 'utf8');
    return 'created';
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return 'skipped_invalid_json';
  }

  const permission = (parsed.permission ?? {}) as Record<string, unknown>;
  const mcp = (permission.mcp ?? {}) as Record<string, unknown>;
  if (mcp[serverName] === 'allow') {
    return 'unchanged';
  }

  mcp[serverName] = 'allow';
  permission.mcp = mcp;
  parsed.permission = permission;
  fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  return 'merged';
};

export const mergeOpenCodePermission = (projectPath: string): PreApprovalStatus =>
  mergeOpenCodeMcpPermission(projectPath, 'tenet');

export const mergeOpenCodePlaywrightPermission = (projectPath: string): PreApprovalStatus =>
  mergeOpenCodeMcpPermission(projectPath, 'playwright');

/**
 * Add project-scoped trust to .codex/config.toml so Codex auto-approves this
 * project (and only this project — global approval_policy is untouched).
 *
 * - Missing block → append `[projects."<abs>"] trust_level = "trusted"`.
 * - Present with trust_level="trusted" → skip (unchanged).
 * - Present with trust_level="untrusted" → respect user choice, return
 *   'skipped_user_untrusted' so the caller can warn.
 */
export const mergeCodexProjectTrust = (projectPath: string): PreApprovalStatus => {
  const absPath = fs.realpathSync(path.resolve(projectPath));
  const codexDir = path.join(projectPath, '.codex');
  const configPath = path.join(codexDir, 'config.toml');

  const blockHeader = `[projects."${absPath}"]`;
  const newBlock = `${blockHeader}\ntrust_level = "trusted"\n`;

  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(configPath, newBlock, 'utf8');
    return 'created';
  }

  const existing = fs.readFileSync(configPath, 'utf8');

  // Look for an existing [projects."<abs>"] block and check its trust_level.
  // Naive scan — sufficient because TOML headers are line-anchored and exact-match.
  const headerIndex = existing.indexOf(blockHeader);
  if (headerIndex === -1) {
    const separator = existing.endsWith('\n') ? '\n' : '\n\n';
    fs.appendFileSync(configPath, `${separator}${newBlock}`, 'utf8');
    return 'merged';
  }

  // Extract the rest of the block up to the next [section] header or EOF.
  const afterHeader = existing.slice(headerIndex + blockHeader.length);
  const nextHeaderMatch = afterHeader.match(/\n\[/);
  const blockBody = nextHeaderMatch
    ? afterHeader.slice(0, nextHeaderMatch.index)
    : afterHeader;

  if (/trust_level\s*=\s*"trusted"/.test(blockBody)) {
    return 'unchanged';
  }
  if (/trust_level\s*=\s*"untrusted"/.test(blockBody)) {
    return 'skipped_user_untrusted';
  }

  // Block exists but lacks trust_level — append the field to the block.
  // Safe strategy: insert the field right after the header line.
  const insertAt = headerIndex + blockHeader.length;
  const updated =
    existing.slice(0, insertAt) + '\ntrust_level = "trusted"' + existing.slice(insertAt);
  fs.writeFileSync(configPath, updated, 'utf8');
  return 'merged';
};
