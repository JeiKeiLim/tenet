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
  'lessons',
  'steer',
  'bootstrap',
  'visuals',
];

const VALID_AGENTS = ['claude-code', 'opencode', 'codex'] as const;

type InitOptions = {
  agent?: string;
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

const copySkillFile = (projectPath: string): void => {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  const sourceSkill = path.resolve(currentDir, '../../skills/tenet/SKILL.md');
  const targetSkill = path.join(projectPath, '.claude', 'skills', 'tenet', 'SKILL.md');

  if (!fs.existsSync(sourceSkill)) {
    return;
  }

  fs.mkdirSync(path.dirname(targetSkill), { recursive: true });
  fs.copyFileSync(sourceSkill, targetSkill);
};

const copyPhasesDocs = (projectPath: string): void => {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  const sourcePhasesDir = path.resolve(currentDir, '../../skills/tenet/phases');
  const targetPhasesDir = path.join(projectPath, '.claude', 'skills', 'tenet', 'phases');

  if (!fs.existsSync(sourcePhasesDir)) {
    return;
  }

  fs.mkdirSync(targetPhasesDir, { recursive: true });

  const files = fs.readdirSync(sourcePhasesDir);
  for (const file of files) {
    if (file.endsWith('.md')) {
      fs.copyFileSync(
        path.join(sourcePhasesDir, file),
        path.join(targetPhasesDir, file),
      );
    }
  }
};

export function initProject(projectPath: string, options?: InitOptions): void {
  const tenetRoot = path.join(projectPath, '.tenet');
  if (fs.existsSync(tenetRoot)) {
    throw new Error(`.tenet already exists at ${tenetRoot}`);
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

  copySkillFile(projectPath);
  copyPhasesDocs(projectPath);
  copyCodexSkill(projectPath);
  writeMcpJson(projectPath);
  mergeOpenCodeConfig(projectPath);
}

/**
 * Copy tenet skill to Codex-compatible location (.agents/skills/tenet/).
 * Codex CLI discovers skills from .agents/skills/{name}/SKILL.md.
 */
const copyCodexSkill = (projectPath: string): void => {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  const sourcePhasesDir = path.resolve(currentDir, '../../skills/tenet/phases');
  const sourceSkill = path.resolve(currentDir, '../../skills/tenet/SKILL.md');

  // Copy SKILL.md to .agents/skills/tenet/
  const codexSkillDir = path.join(projectPath, '.agents', 'skills', 'tenet');
  if (fs.existsSync(sourceSkill)) {
    fs.mkdirSync(codexSkillDir, { recursive: true });
    fs.copyFileSync(sourceSkill, path.join(codexSkillDir, 'SKILL.md'));
  }

  // Copy phase docs to .agents/skills/tenet/phases/
  if (fs.existsSync(sourcePhasesDir)) {
    const codexPhasesDir = path.join(codexSkillDir, 'phases');
    fs.mkdirSync(codexPhasesDir, { recursive: true });
    for (const file of fs.readdirSync(sourcePhasesDir)) {
      if (file.endsWith('.md')) {
        fs.copyFileSync(
          path.join(sourcePhasesDir, file),
          path.join(codexPhasesDir, file),
        );
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
