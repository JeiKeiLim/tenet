import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const REQUIRED_DIRS = [
  'interview',
  'spec',
  'harness',
  'status',
  'knowledge',
  'journal',
  'steer',
  'bootstrap',
  'visuals',
];

const VALID_AGENTS = ['claude-code', 'opencode', 'codex'] as const;

type InitOptions = {
  agent?: string;
  upgrade?: boolean;
};

const TEMPLATE_FILES: Record<string, string> = {
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
  'harness/current.md': `# Harness: Quality Contract

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
};

const ensureFile = (filePath: string, content: string): void => {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content, 'utf8');
  }
};

type StateConfig = {
  default_agent?: string;
  max_retries?: number;
  timeout_minutes?: number;
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
        fs.copyFileSync(entryPath, path.join(targetDir, entry));
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

  for (const [relativePath, content] of Object.entries(TEMPLATE_FILES)) {
    ensureFile(path.join(tenetRoot, relativePath), content);
  }

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

  // Overwrite skill files (these are tenet-owned, not user-edited)
  copySkillDirs(projectPath);
  copyCodexSkill(projectPath);

  // Re-merge MCP configs (idempotent — won't overwrite if tenet entry exists)
  writeMcpJson(projectPath);
  mergeOpenCodeConfig(projectPath);
  writeCodexConfig(projectPath);

  // Do NOT overwrite: harness, spec, interview, knowledge, journal, status, steer, bootstrap
  // Do NOT touch: .state/tenet.db, .state/config.json
}

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
        fs.copyFileSync(filePath, path.join(codexSkillDir, file));
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
 * Write project-local .codex/config.toml for Codex CLI MCP server discovery.
 * Format: [mcp_servers.tenet] with command and args.
 * Note: mcp_servers (with underscore) is required — mcp-servers is silently ignored.
 */
const writeCodexConfig = (projectPath: string): void => {
  const codexDir = path.join(projectPath, '.codex');
  const configPath = path.join(codexDir, 'config.toml');

  if (fs.existsSync(configPath)) {
    const existing = fs.readFileSync(configPath, 'utf8');
    if (existing.includes('[mcp_servers.tenet]')) {
      return;
    }
    // Append tenet MCP server config
    const toAppend = '\n[mcp_servers.tenet]\ncommand = "tenet"\nargs = ["serve"]\n';
    fs.appendFileSync(configPath, toAppend, 'utf8');
    return;
  }

  fs.mkdirSync(codexDir, { recursive: true });
  const content = '[mcp_servers.tenet]\ncommand = "tenet"\nargs = ["serve"]\n';
  fs.writeFileSync(configPath, content, 'utf8');
};

const OPENCODE_MCP_ENTRY = {
  type: 'local' as const,
  command: ['tenet', 'serve'],
};

const mergeOpenCodeConfig = (projectPath: string): void => {
  const configPath = path.join(projectPath, 'opencode.json');
  if (fs.existsSync(configPath)) {
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const mcp = (existing.mcp ?? {}) as Record<string, unknown>;
    if (mcp.tenet) {
      return;
    }
    mcp.tenet = OPENCODE_MCP_ENTRY;
    existing.mcp = mcp;
    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
    return;
  }
  const config = { mcp: { tenet: OPENCODE_MCP_ENTRY } };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
};
