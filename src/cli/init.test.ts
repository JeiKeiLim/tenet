import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from './init.js';

const tempDirs: string[] = [];

const createTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-test-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('initProject', () => {
  it('initializes fresh project with expected directories and template files', () => {
    const projectPath = createTempDir();
    initProject(projectPath);

    const tenetRoot = path.join(projectPath, '.tenet');
    const expectedDirs = [
      'interview',
      'spec',
      'harness',
      'status',
      'knowledge',
      'journal',
      'steer',
      'bootstrap',
      'visuals',
      '.state',
    ];

    for (const dir of expectedDirs) {
      expect(fs.existsSync(path.join(tenetRoot, dir))).toBe(true);
    }

    const expectedFiles = [
      'status/status.md',
      'status/job-queue.md',
      'status/backlog.md',
      'steer/inbox.md',
      'steer/processed.md',
      'harness/current.md',
      'bootstrap/compiler.md',
    ];

    for (const file of expectedFiles) {
      expect(fs.existsSync(path.join(tenetRoot, file))).toBe(true);
    }

    const statusContent = fs.readFileSync(path.join(tenetRoot, 'status/status.md'), 'utf8');
    expect(statusContent).toContain('# Status');
    expect(statusContent).toContain('- mode: unset');
  });

  it('copies SKILL.md into .claude/skills/tenet', () => {
    const projectPath = createTempDir();
    initProject(projectPath);

    const copiedSkillPath = path.join(projectPath, '.claude', 'skills', 'tenet', 'SKILL.md');
    expect(fs.existsSync(copiedSkillPath)).toBe(true);

    const initFile = fileURLToPath(import.meta.url);
    const sourceSkillPath = path.resolve(path.dirname(initFile), '../../skills/tenet/SKILL.md');
    const copiedContent = fs.readFileSync(copiedSkillPath, 'utf8');
    const sourceContent = fs.readFileSync(sourceSkillPath, 'utf8');
    expect(copiedContent).toBe(sourceContent);
  });

  it('copies phase docs into .claude/skills/tenet/phases', () => {
    const projectPath = createTempDir();
    initProject(projectPath);

    const phasesDir = path.join(projectPath, '.claude', 'skills', 'tenet', 'phases');
    expect(fs.existsSync(phasesDir)).toBe(true);

    const expectedPhases = [
      '01-interview.md',
      '02-spec-and-harness.md',
      '03-visuals.md',
      '04-decomposition.md',
      '05-execution-loop.md',
      '06-evaluation.md',
    ];

    for (const phase of expectedPhases) {
      expect(fs.existsSync(path.join(phasesDir, phase))).toBe(true);
    }
  });

  it('throws when .tenet already exists', () => {
    const projectPath = createTempDir();
    fs.mkdirSync(path.join(projectPath, '.tenet'), { recursive: true });

    expect(() => initProject(projectPath)).toThrowError(/\.tenet already exists.*--upgrade/);
  });

  it('creates harness template with expected sections', () => {
    const projectPath = createTempDir();
    initProject(projectPath);

    const harnessPath = path.join(projectPath, '.tenet', 'harness', 'current.md');
    const harness = fs.readFileSync(harnessPath, 'utf8');

    expect(harness).toContain('# Harness: Quality Contract');
    expect(harness).toContain('## Formatting & Linting');
    expect(harness).toContain('## Testing Requirements');
    expect(harness).toContain('## Architecture Rules');
    expect(harness).toContain('## Code Principles');
    expect(harness).toContain('## Danger Zones (do not modify)');
    expect(harness).toContain('## Iron Laws');
  });

  it('writes .mcp.json for Claude Code auto-discovery', () => {
    const projectPath = createTempDir();
    initProject(projectPath);

    const mcpJsonPath = path.join(projectPath, '.mcp.json');
    expect(fs.existsSync(mcpJsonPath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
    expect(content.mcpServers.tenet).toBeDefined();
    expect(content.mcpServers.tenet.command).toBe('tenet');
    expect(content.mcpServers.tenet.args).toEqual(['serve']);
  });

  it('merges into existing .mcp.json without overwriting other servers', () => {
    const projectPath = createTempDir();
    const mcpJsonPath = path.join(projectPath, '.mcp.json');
    fs.writeFileSync(mcpJsonPath, JSON.stringify({
      mcpServers: { other: { command: 'other-cmd', args: [] } }
    }), 'utf8');

    initProject(projectPath);

    const content = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
    expect(content.mcpServers.other).toBeDefined();
    expect(content.mcpServers.tenet).toBeDefined();
  });

  it('writes opencode.json for OpenCode auto-discovery', () => {
    const projectPath = createTempDir();
    initProject(projectPath);

    const configPath = path.join(projectPath, 'opencode.json');
    expect(fs.existsSync(configPath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(content.mcp.tenet).toBeDefined();
    expect(content.mcp.tenet.type).toBe('local');
    expect(content.mcp.tenet.command).toEqual(['tenet', 'serve']);
  });

  it('copies skill files into .agents/skills/tenet for Codex compatibility', () => {
    const projectPath = createTempDir();
    initProject(projectPath);

    const codexSkillPath = path.join(projectPath, '.agents', 'skills', 'tenet', 'SKILL.md');
    expect(fs.existsSync(codexSkillPath)).toBe(true);

    const codexPhasesDir = path.join(projectPath, '.agents', 'skills', 'tenet', 'phases');
    expect(fs.existsSync(codexPhasesDir)).toBe(true);

    // Verify content matches source
    const initFile = fileURLToPath(import.meta.url);
    const sourceSkillPath = path.resolve(path.dirname(initFile), '../../skills/tenet/SKILL.md');
    expect(fs.readFileSync(codexSkillPath, 'utf8')).toBe(fs.readFileSync(sourceSkillPath, 'utf8'));
  });

  it('writes .codex/config.toml for Codex MCP discovery', () => {
    const projectPath = createTempDir();
    initProject(projectPath);

    const configPath = path.join(projectPath, '.codex', 'config.toml');
    expect(fs.existsSync(configPath)).toBe(true);

    const content = fs.readFileSync(configPath, 'utf8');
    expect(content).toContain('[mcp_servers.tenet]');
    expect(content).toContain('command = "tenet"');
    expect(content).toContain('args = ["serve"]');
  });

  it('appends to existing .codex/config.toml without overwriting', () => {
    const projectPath = createTempDir();
    const codexDir = path.join(projectPath, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, 'config.toml'),
      '[mcp_servers.github]\ncommand = "gh-mcp"\n',
      'utf8',
    );

    initProject(projectPath);

    const content = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');
    expect(content).toContain('[mcp_servers.github]');
    expect(content).toContain('[mcp_servers.tenet]');
  });

  it('merges into existing opencode.json without overwriting other config', () => {
    const projectPath = createTempDir();
    const configPath = path.join(projectPath, 'opencode.json');
    fs.writeFileSync(configPath, JSON.stringify({
      model: 'claude-sonnet',
      mcp: { github: { type: 'local', command: ['gh-mcp'] } }
    }), 'utf8');

    initProject(projectPath);

    const content = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(content.model).toBe('claude-sonnet');
    expect(content.mcp.github).toBeDefined();
    expect(content.mcp.tenet).toBeDefined();
  });
});
