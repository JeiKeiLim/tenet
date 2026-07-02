import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { StateStore, statePaths } from '../core/state-store.js';
import { TENET_MCP_TOOL_NAMES } from '../mcp/tools/tool-names.js';
import { getPackageVersion } from './version.js';

const REQUIRED_DIRS = [
  'project',
  'project/design-components',
  'runs',
  'archive',
  'knowledge',
  'status',
  'state-snapshot',
  'critics',
];

/**
 * Legacy top-level document directories MOVED into archive/legacy-v1/ by the
 * one-time upgrade migration. knowledge/ is included: context bootstrap's
 * legacy lane reads the archived copy and curates durable facts back into a
 * fresh top-level .tenet/knowledge/. Active runtime lanes (status/,
 * state-snapshot/, .state/, runs/, project/) are never moved.
 */
const LEGACY_DOC_DIRS = [
  'spec',
  'interview',
  'decomposition',
  'harness',
  'journal',
  'visuals',
  'bootstrap',
  'steer',
  'knowledge',
];

const LEGACY_FILES = ['DESIGN.md'];

const ARCHIVE_LEGACY_ROOT = path.join('archive', 'legacy-v1');

const VALID_AGENTS = ['claude-code', 'opencode', 'codex'] as const;

type InitOptions = {
  agent?: string;
  upgrade?: boolean;
  /**
   * Opt in to the one-time destructive legacy-document migration on upgrade.
   * Defaults to false: the move never runs unless the caller (CLI consent gate)
   * explicitly enables it. Destructive for pre-migration jobs — their
   * artifact_paths dangle after the move.
   */
  migrateLegacy?: boolean;
};

const PORTABLE_STATE_README = `# Tenet State Snapshot

This directory is for portable Tenet SQLite snapshots that are safe to track in Git.

- Run \`tenet db snapshot\` to write a gzip-compressed \`state-snapshot/tenet.db.gz\` (use \`--no-compress\` for a plain \`tenet.db\`).
- Run \`tenet db restore-snapshot\` to restore live runtime state from the snapshot (auto-detects compressed or plain).
- Do not track \`.tenet/.state/\`; it is the live SQLite WAL database.
`;

/**
 * Default critic roster. The 3 built-ins are enabled (today's behavior); the
 * disabled `security` entry documents the custom-critic shape — flip `enabled`
 * to true and write its prompt file under .tenet/critics/ to activate it.
 * See skills/tenet/critics.md (the critic designer) for how to author one.
 */
const CRITICS_ROSTER_TEMPLATE = `{
  "version": 1,
  "critics": [
    { "id": "code_critic", "builtin": true, "enabled": true, "full_context": true },
    { "id": "test_critic", "builtin": true, "enabled": true, "full_context": true },
    { "id": "interaction_e2e", "builtin": true, "enabled": true, "full_context": false },
    {
      "id": "security",
      "builtin": false,
      "enabled": false,
      "stage": "security_critic",
      "job_type": "critic_eval",
      "prompt_file": ".tenet/critics/security.md",
      "full_context": true
    }
  ]
}
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
  'state-snapshot/README.md': PORTABLE_STATE_README,
  'critics.json': CRITICS_ROSTER_TEMPLATE,
  'critics/.gitkeep': '',
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

const REQUIRED_ROOT_GITIGNORE_LINES = ['.tenet/.state/'];

/**
 * Defense-in-depth: ensure the repo-ROOT .gitignore also ignores the live SQLite
 * state, not just .tenet/.gitignore. The nested .tenet/.gitignore (written by
 * ensureTenetGitignore) protects locally, but a root rule also covers collaborators
 * before .tenet/.gitignore is committed.
 *
 * Merges into an existing root .gitignore only — never creates one, to avoid
 * surprising repos that intentionally omit it. Idempotent; preserves custom rules.
 */
export const ensureRootGitignore = (projectPath: string): void => {
  const gitignorePath = path.join(projectPath, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    return;
  }

  const existing = fs.readFileSync(gitignorePath, 'utf8');
  const existingLines = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const missingLines = REQUIRED_ROOT_GITIGNORE_LINES.filter((line) => !existingLines.has(line));
  if (missingLines.length === 0) {
    return;
  }

  const separator = existing.endsWith('\n') ? '\n' : '\n\n';
  fs.appendFileSync(
    gitignorePath,
    `${separator}# Tenet live SQLite runtime state. Do not track this in Git.\n${missingLines.join('\n')}\n`,
    'utf8',
  );
};

/**
 * Detect whether the live SQLite DB (or its WAL/SHM sidecars) under .tenet/.state/
 * is already tracked by Git, and warn with the exact untrack command. A tracked DB
 * is the main source of DB corruption: git checkout/merge/stash can overwrite a
 * live WAL database mid-write. .tenet/.gitignore only prevents tracking NEW files —
 * it cannot untrack a DB committed before the rule existed.
 *
 * Non-blocking and advisory: prints a warning only. Does not run `git rm` itself
 * (that mutates the index and would surprise the user). No-op when the project is
 * not inside a git work tree or git is unavailable.
 */
export const detectTrackedStateFiles = (projectPath: string): void => {
  let insideWorkTree: string;
  try {
    insideWorkTree = execSync('git rev-parse --is-inside-work-tree', {
      cwd: projectPath,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
      encoding: 'utf8',
    }).trim();
  } catch {
    return; // not a git repo or git unavailable — nothing to detect
  }
  if (insideWorkTree !== 'true') {
    return;
  }

  let tracked: string;
  try {
    tracked = execSync('git ls-files -- .tenet/.state', {
      cwd: projectPath,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
      encoding: 'utf8',
    }).trim();
  } catch {
    return;
  }
  if (!tracked) {
    return;
  }

  const { dbPath, walPath, shmPath } = statePaths(projectPath);
  const dbBasenames = new Set([dbPath, walPath, shmPath].map((p) => path.basename(p)));
  const offending = tracked
    .split(/\r?\n/)
    .map((rel) => rel.trim())
    .filter((rel) => rel.length > 0 && dbBasenames.has(path.basename(rel)));

  if (offending.length === 0) {
    return;
  }

  console.warn(
    `\nWarning: ${offending.join(', ')} under .tenet/.state/ is tracked by Git. ` +
      'Git operations (checkout/merge/stash) can corrupt a live SQLite WAL database. ' +
      'Untrack it (the local file is kept), then commit the removal:\n' +
      `  git rm --cached --ignore-unmatch ${offending.join(' ')}\n` +
      '.tenet/.gitignore already ignores .state/ for future files.',
  );
};

/**
 * Ensure the live SQLite state is neither newly tracked nor silently corrupted by
 * an already-tracked DB: merge a defense-in-depth rule into the root .gitignore,
 * then warn if a DB file is already committed.
 */
const ensureStateDbGitSafety = (projectPath: string): void => {
  ensureRootGitignore(projectPath);
  detectTrackedStateFiles(projectPath);
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
  opencode_args_interaction_e2e?: string;
  codex_args_interaction_e2e?: string;
  claude_args_interaction_e2e?: string;
  /** Per-project star-nudge state (see src/cli/star-nudge.ts). */
  star_nudge?: { starredAt?: string };
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
 * Remove markdown files in the target skill copy that no longer exist in the
 * source skill dir (recursively, including subdirs like phases/). Tenet-owned
 * skill copies are regenerated each upgrade, so deleted phase files
 * (e.g. 00-brownfield-scan.md) must not linger across versions.
 */
const pruneDeletedSkillFiles = (sourceDir: string, targetDir: string): void => {
  if (!fs.existsSync(targetDir)) {
    return;
  }
  const sourceEntries = fs.existsSync(sourceDir) ? new Set(fs.readdirSync(sourceDir)) : new Set<string>();
  for (const entry of fs.readdirSync(targetDir)) {
    const targetEntry = path.join(targetDir, entry);
    const stat = fs.statSync(targetEntry);
    if (stat.isDirectory()) {
      pruneDeletedSkillFiles(path.join(sourceDir, entry), targetEntry);
    } else if (entry.endsWith('.md') && !sourceEntries.has(entry)) {
      fs.rmSync(targetEntry, { force: true });
    }
  }
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

    pruneDeletedSkillFiles(sourceDir, targetDir);
  }
};

export function initProject(projectPath: string, options?: InitOptions): void {
  const tenetRoot = path.join(projectPath, '.tenet');

  if (options?.upgrade) {
    if (!fs.existsSync(tenetRoot)) {
      throw new Error('No .tenet directory found. Run `tenet init` first.');
    }
    // Upgrade: overwrite skills and MCP configs, preserve user docs
    upgradeProject(projectPath, options);
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
  ensureStateDbGitSafety(projectPath);

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
function upgradeProject(projectPath: string, options?: InitOptions): void {
  const tenetRoot = path.join(projectPath, '.tenet');

  // Ensure any new directories exist (added in newer versions)
  for (const dir of REQUIRED_DIRS) {
    fs.mkdirSync(path.join(tenetRoot, dir), { recursive: true });
  }
  fs.mkdirSync(path.join(tenetRoot, '.state'), { recursive: true });
  ensureTemplateFiles(tenetRoot);
  ensurePortableStateFiles(tenetRoot);
  ensureStateDbGitSafety(projectPath);

  backupStateDb(tenetRoot);
  const stateStore = new StateStore(projectPath, { migrate: true });
  warnIfJobsActive(stateStore);
  stateStore.close();

  migrateLegacyDocuments(tenetRoot, { enabled: options?.migrateLegacy === true });
  migrateLegacyCriticRosterId(projectPath);
  migrateCriticRosterFullContext(projectPath);

  // Overwrite skill files (these are tenet-owned, not user-edited)
  copySkillDirs(projectPath);
  copyCodexSkill(projectPath);

  // Re-merge MCP configs (idempotent — won't overwrite if tenet entry exists)
  writeMcpJson(projectPath);
  mergeOpenCodeConfig(projectPath);
  writeCodexConfig(projectPath);

  // User docs are preserved in place except for the one-time legacy migration
  // (see migrateLegacyDocuments): legacy doc dirs + DESIGN.md are MOVED into
  // archive/legacy-v1/ and knowledge/ is snapshotted there. project/ templates,
  // status/, state-snapshot/, and .state/config.json are never overwritten.
}

/**
 * Rewrite the legacy `playwright_eval` built-in id (and any custom critic's
 * `job_type: "playwright_eval"`) to `interaction_e2e` in a project's
 * `.tenet/critics.json`. Run during `tenet init --upgrade` so the file a user
 * opens matches the post-rename identifier.
 *
 * The roster resolver ALSO aliases the old id as a safety net, so this is
 * cosmetic — but it removes the "wait, is this broken?" moment when a user
 * sees the old name still sitting in their file. Targeted string replace: only
 * the legacy token changes (order, enabled flags, custom critics, and formatting
 * are preserved). Idempotent — a no-op once the file is clean.
 */
const migrateLegacyCriticRosterId = (projectPath: string): void => {
  const rosterPath = path.join(projectPath, '.tenet', 'critics.json');
  if (!fs.existsSync(rosterPath)) {
    return;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(rosterPath, 'utf8');
  } catch {
    return;
  }
  if (!raw.includes('playwright_eval')) {
    return;
  }
  // `playwright_eval` only appears in a critics.json as a built-in id or a
  // custom critic's job_type — both should become interaction_e2e.
  fs.writeFileSync(rosterPath, raw.replace(/playwright_eval/g, 'interaction_e2e'), 'utf8');
  console.log('Updated .tenet/critics.json: renamed playwright_eval → interaction_e2e.');
};

/**
 * Append `"full_context": true` to a single flat critic-entry object that lacks it,
 * preserving the entry's one-line or multi-line style. See
 * migrateCriticRosterFullContext.
 */
const addFullContextToEntry = (entry: string): string => {
  if (entry.includes('"full_context"')) {
    return entry;
  }
  // Multi-line entry whose closing brace sits on its own line: comma the last value
  // and insert a new key line at the keys' indent.
  const indentMatch = entry.match(/\n([ \t]+)"/);
  const indent = indentMatch ? indentMatch[1] : '  ';
  const multiline = entry.replace(
    /(\S)(\s*\n[ \t]*\})$/,
    `$1,\n${indent}"full_context": true$2`,
  );
  if (multiline !== entry) {
    return multiline;
  }
  // Brace on the value's line (incl. pure one-liners): insert before the captured
  // trailing whitespace + brace so the closing brace is preserved.
  return entry.replace(/(\s*\})$/, `, "full_context": true$1`);
};

/**
 * Add `"full_context": true` to every critic entry in a project's
 * `.tenet/critics.json` that lacks it. Surfaces the grounded/ungrounded option in
 * the file itself so pre-existing configs discover it on `tenet init --upgrade`
 * without reading the docs.
 *
 * Like migrateLegacyCriticRosterId above, this is a targeted transform that
 * preserves the user's formatting: one-line entries stay one-line, multi-line
 * entries keep their indentation and key order, and only the missing key is
 * appended. Idempotent — a no-op once every entry already carries full_context.
 * Invalid JSON is left untouched (parsed first as a guard; never write back a
 * corrupt transform).
 */
const migrateCriticRosterFullContext = (projectPath: string): void => {
  const rosterPath = path.join(projectPath, '.tenet', 'critics.json');
  if (!fs.existsSync(rosterPath)) {
    return;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(rosterPath, 'utf8');
  } catch {
    return;
  }
  // Guard: only transform well-formed JSON — a corrupt file is left for the user.
  try {
    JSON.parse(raw);
  } catch {
    return;
  }
  // Critic entries are flat objects (no nested braces); each `{ ... }` here is one
  // entry. Append full_context to those missing it, preserving style.
  const migrated = raw.replace(/\{[^{}]*\}/g, (entry) => addFullContextToEntry(entry));
  if (migrated === raw) {
    return;
  }
  fs.writeFileSync(rosterPath, migrated, 'utf8');
  console.log('Updated .tenet/critics.json: added full_context to critic entries.');
};

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

const isDirNonEmpty = (dir: string): boolean => {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return false;
  }
  return fs.readdirSync(dir).length > 0;
};

/**
 * Non-mutating read of which legacy top-level dirs/files a migration would move.
 * Shared by previewLegacyMigration (for the CLI consent prompt) and
 * migrateLegacyDocuments (the actual move) so both agree on the plan.
 */
const computeLegacyMigrationPlan = (tenetRoot: string): { dirs: string[]; files: string[] } => {
  const dirs: string[] = [];
  for (const dir of LEGACY_DOC_DIRS) {
    if (isDirNonEmpty(path.join(tenetRoot, dir))) {
      dirs.push(dir);
    }
  }

  const files: string[] = [];
  for (const file of LEGACY_FILES) {
    const source = path.join(tenetRoot, file);
    if (fs.existsSync(source) && fs.statSync(source).isFile()) {
      files.push(file);
    }
  }

  return { dirs, files };
};

export type LegacyMigrationPreview = {
  /** archive/legacy-v1/ marker exists — a prior upgrade already migrated. */
  alreadyMigrated: boolean;
  /** Non-empty legacy dirs that would move. */
  dirs: string[];
  /** Legacy files (e.g. DESIGN.md) that would move. */
  files: string[];
  /** Whether there is anything to move (dirs + files). */
  hasWork: boolean;
};

/**
 * Read-only preview of the legacy-document migration. Used by the CLI consent
 * gate to decide whether to prompt and to show the user what would move. Does
 * not touch the filesystem.
 */
export const previewLegacyMigration = (tenetRoot: string): LegacyMigrationPreview => {
  const alreadyMigrated = fs.existsSync(path.join(tenetRoot, ARCHIVE_LEGACY_ROOT));
  if (alreadyMigrated) {
    return { alreadyMigrated: true, dirs: [], files: [], hasWork: false };
  }
  const { dirs, files } = computeLegacyMigrationPlan(tenetRoot);
  return { alreadyMigrated: false, dirs, files, hasWork: dirs.length + files.length > 0 };
};

/**
 * One-time migration of legacy top-level document directories into
 * .tenet/archive/legacy-v1/. Moves legacy doc dirs + DESIGN.md (rename) and
 * archives knowledge/ (the active-lane dir is recreated empty). Idempotent: the
 * presence of the archive/legacy-v1/ marker means a prior upgrade already
 * migrated, so this is a no-op on re-run.
 *
 * Gated by `enabled`: the destructive move only runs when the CLI consent gate
 * (interactive Y/N or the --migrate-legacy flag) explicitly opts in. When
 * disabled, this is a silent no-op — the CLI owns the messaging.
 *
 * Destructive for pre-migration jobs: their artifact_paths point at the old
 * top-level locations and will dangle after the move. Callers should warn
 * before running this while jobs are active (see warnIfJobsActive).
 */
const migrateLegacyDocuments = (tenetRoot: string, opts: { enabled: boolean }): void => {
  if (!opts.enabled) {
    return;
  }

  const archiveLegacyRoot = path.join(tenetRoot, ARCHIVE_LEGACY_ROOT);
  if (fs.existsSync(archiveLegacyRoot)) {
    return;
  }

  fs.mkdirSync(archiveLegacyRoot, { recursive: true });

  const plan = computeLegacyMigrationPlan(tenetRoot);

  const movedDirs: string[] = [];
  for (const dir of plan.dirs) {
    fs.renameSync(path.join(tenetRoot, dir), path.join(archiveLegacyRoot, dir));
    movedDirs.push(dir);
  }

  // knowledge/ is an active lane, not a retired legacy dir: its legacy content
  // was archived above, but the top-level dir must remain (empty) as the active
  // home context bootstrap curates durable facts back into.
  fs.mkdirSync(path.join(tenetRoot, 'knowledge'), { recursive: true });

  const movedFiles: string[] = [];
  for (const file of plan.files) {
    fs.renameSync(path.join(tenetRoot, file), path.join(archiveLegacyRoot, file));
    movedFiles.push(file);
  }

  if (movedDirs.length === 0 && movedFiles.length === 0) {
    return;
  }

  console.log('\nMigrated legacy Tenet documents into .tenet/archive/legacy-v1/:');
  if (movedDirs.length > 0) {
    console.log(`  moved: ${movedDirs.join(', ')}`);
  }
  if (movedFiles.length > 0) {
    console.log(`  moved files: ${movedFiles.join(', ')}`);
  }
  console.log(
    '  Context bootstrap curates durable facts from archive/legacy-v1/knowledge/ back into top-level .tenet/knowledge/.',
  );
  console.log(
    '  Pre-migration jobs reference the old top-level paths and can no longer be re-compiled/retried.',
  );
};

/**
 * Warn (non-blocking) when pending/running jobs exist at upgrade time. Their
 * artifact_paths may point at legacy top-level docs that the migration moves.
 */
const warnIfJobsActive = (stateStore: StateStore): void => {
  const active =
    stateStore.getJobsByStatus('pending').length + stateStore.getJobsByStatus('running').length;
  if (active === 0) {
    return;
  }
  console.warn(
    `\nWarning: ${active} pending/running job(s) detected. tenet init --upgrade moves legacy document ` +
      'directories, which breaks artifact_paths for pre-upgrade jobs (compile_context / tenet_retry_job ' +
      'will fail). Consider finishing or cancelling active runs before upgrading.',
  );
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

    pruneDeletedSkillFiles(sourceDir, codexSkillDir);
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
