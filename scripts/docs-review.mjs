#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_AGENTS = ['claude'];
const DEFAULT_SYNTHESIZER = 'claude';
const VALID_AGENTS = new Set(['claude', 'codex', 'opencode']);
const VALID_SYNTHESIZERS = new Set(['claude', 'codex', 'opencode', 'none']);
const VALID_SCOPES = new Set(['current', 'all']);
const VALID_FAIL_MODES = new Set(['blocking', 'any', 'never']);
const DEFAULT_TIMEOUT_MINUTES = 30;

const SEVERITY_ORDER = {
  blocking: 3,
  warning: 2,
  info: 1,
};

const REVIEWER_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['summary', 'findings'],
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'severity', 'doc_claim', 'code_evidence', 'recommendation'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          severity: { type: 'string', enum: ['blocking', 'warning', 'info'] },
          category: { type: 'string' },
          doc_paths: { type: 'array', items: { type: 'string' } },
          code_paths: { type: 'array', items: { type: 'string' } },
          doc_claim: { type: 'string' },
          code_evidence: { type: 'string' },
          recommendation: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
};

export const normalizeAgentName = (name) => {
  const normalized = String(name ?? '').trim().toLowerCase();
  if (normalized === 'claude-code') return 'claude';
  return normalized;
};

export const parseArgs = (argv) => {
  const options = {
    agents: [...DEFAULT_AGENTS],
    scope: 'current',
    jsonOut: null,
    markdownOut: null,
    print: true,
    failOn: 'blocking',
    timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
    repoRoot: null,
    synthesizer: DEFAULT_SYNTHESIZER,
  };

  const readValue = (tokens, index, flag) => {
    const current = tokens[index];
    if (current.includes('=')) {
      return [current.slice(current.indexOf('=') + 1), index];
    }
    if (index + 1 >= tokens.length) {
      throw new Error(`${flag} requires a value`);
    }
    return [tokens[index + 1], index + 1];
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const flag = token.split('=')[0];

    switch (flag) {
      case '--agents': {
        const [value, next] = readValue(argv, i, '--agents');
        i = next;
        const agents = value.split(',').map(normalizeAgentName).filter(Boolean);
        if (agents.length === 0) {
          throw new Error('--agents must include at least one agent');
        }
        for (const agent of agents) {
          if (!VALID_AGENTS.has(agent)) {
            throw new Error(`unknown agent: ${agent}`);
          }
        }
        options.agents = agents;
        break;
      }
      case '--synthesizer': {
        const [value, next] = readValue(argv, i, '--synthesizer');
        i = next;
        const synthesizer = normalizeAgentName(value);
        if (!VALID_SYNTHESIZERS.has(synthesizer)) {
          throw new Error('--synthesizer must be claude, codex, opencode, or none');
        }
        options.synthesizer = synthesizer;
        break;
      }
      case '--scope': {
        const [value, next] = readValue(argv, i, '--scope');
        i = next;
        if (!VALID_SCOPES.has(value)) {
          throw new Error('--scope must be current or all');
        }
        options.scope = value;
        break;
      }
      case '--json-out': {
        const [value, next] = readValue(argv, i, '--json-out');
        i = next;
        options.jsonOut = value;
        break;
      }
      case '--markdown-out': {
        const [value, next] = readValue(argv, i, '--markdown-out');
        i = next;
        options.markdownOut = value;
        break;
      }
      case '--no-print':
        options.print = false;
        break;
      case '--fail-on': {
        const [value, next] = readValue(argv, i, '--fail-on');
        i = next;
        if (!VALID_FAIL_MODES.has(value)) {
          throw new Error('--fail-on must be blocking, any, or never');
        }
        options.failOn = value;
        break;
      }
      case '--timeout-minutes': {
        const [value, next] = readValue(argv, i, '--timeout-minutes');
        i = next;
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
          throw new Error('--timeout-minutes must be a positive integer');
        }
        options.timeoutMinutes = parsed;
        break;
      }
      case '--repo-root': {
        const [value, next] = readValue(argv, i, '--repo-root');
        i = next;
        options.repoRoot = path.resolve(value);
        break;
      }
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`unknown option: ${token}`);
    }
  }

  return options;
};

export const findRepoRoot = (startDir = process.cwd()) => {
  let current = path.resolve(startDir);
  while (true) {
    const packagePath = path.join(current, 'package.json');
    if (fs.existsSync(packagePath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
        if (pkg.name === '@jeikeilim/tenet') {
          return current;
        }
      } catch {
        // Keep walking.
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error('could not locate Tenet repository root');
    }
    current = parent;
  }
};

const runGitLsFiles = (repoRoot) => {
  const result = spawnSync('git', ['ls-files'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    return null;
  }

  return result.stdout.split(/\r?\n/).filter(Boolean);
};

const walkFiles = (dir, root = dir, acc = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') {
      continue;
    }

    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(absolute, root, acc);
    } else if (entry.isFile()) {
      acc.push(path.relative(root, absolute).replaceAll(path.sep, '/'));
    }
  }
  return acc;
};

export const listTrackedFiles = (repoRoot) => runGitLsFiles(repoRoot) ?? walkFiles(repoRoot);

export const getReviewDocuments = (repoRoot, scope = 'current') => {
  const tracked = listTrackedFiles(repoRoot);
  const markdown = tracked.filter((file) => file.endsWith('.md'));
  if (scope === 'all') {
    return markdown.sort();
  }

  return markdown
    .filter((file) =>
      file === 'README.md' ||
      file === 'CLAUDE.md' ||
      file === 'AGENTS.md' ||
      file === 'tests/README.md' ||
      file.startsWith('skills/') ||
      (file.startsWith('docs/') && !file.startsWith('docs/planning/'))
    )
    .sort();
};

const readFileIfExists = (repoRoot, relativePath) => {
  const absolute = path.join(repoRoot, relativePath);
  return fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : '';
};

const extractStringArray = (source, variableName) => {
  const re = new RegExp(`(?:const|export const)\\s+${variableName}\\s*=\\s*\\[([\\s\\S]*?)\\](?:\\s+as\\s+const)?`, 'm');
  const match = source.match(re);
  if (!match) return [];
  return Array.from(match[1].matchAll(/['"]([^'"]+)['"]/g), (m) => m[1]);
};

const extractMcpRegistrations = (source) => {
  const registered = new Set();
  const re = /safeRegister\(\s*\(\)\s*=>\s*registerTenet([A-Z][A-Za-z]+)Tool\(/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const pascal = match[1];
    const snake = pascal.replace(/([A-Z])/g, (_c, c) => `_${String(c).toLowerCase()}`).replace(/^_/, '');
    registered.add(`tenet_${snake}`);
  }
  return [...registered].sort();
};

const extractCliCommands = (source) =>
  Array.from(source.matchAll(/\.command\(\s*['"]([^'"]+)['"]/g), (m) => m[1].split(/\s+/)[0]).sort();

const extractCliOptions = (source) =>
  Array.from(source.matchAll(/\.option\(\s*['"`]([^'"`]+)['"`]/g), (m) => m[1]).sort();

const extractNumberConstant = (source, name) => {
  const match = source.match(new RegExp(`export const ${name}\\s*=\\s*(\\d+)`));
  return match ? Number.parseInt(match[1], 10) : null;
};

const extractDefaultMaxRetries = (source) => {
  const match = source.match(/export const DEFAULT_MAX_RETRIES\s*=\s*([^;\n]+)/);
  return match ? match[1].trim() : null;
};

export const extractCodeFacts = (repoRoot) => {
  const packageJson = JSON.parse(readFileIfExists(repoRoot, 'package.json'));
  const toolNamesSource = readFileIfExists(repoRoot, 'src/mcp/tools/tool-names.ts');
  const toolIndexSource = readFileIfExists(repoRoot, 'src/mcp/tools/index.ts');
  const cliSource = readFileIfExists(repoRoot, 'src/cli/index.ts');
  const initSource = readFileIfExists(repoRoot, 'src/cli/init.ts');
  const runtimeSource = readFileIfExists(repoRoot, 'src/core/runtime-config.ts');
  const skillSource = readFileIfExists(repoRoot, 'skills/tenet/SKILL.md');

  const declaredTools = extractStringArray(toolNamesSource, 'TENET_MCP_TOOL_NAMES').sort();
  const registeredTools = extractMcpRegistrations(toolIndexSource);
  const phaseFiles = Array.from(skillSource.matchAll(/phases\/\d{2}-[a-z0-9-]+\.md/g), (m) => m[0]);
  const uniquePhaseFiles = [...new Set(phaseFiles)].sort();

  return {
    package: {
      name: packageJson.name,
      version: packageJson.version,
      bin: packageJson.bin,
      files: packageJson.files,
      scripts: packageJson.scripts,
    },
    mcp: {
      declaredTools,
      registeredTools,
      declaredCount: declaredTools.length,
      registeredCount: registeredTools.length,
      declarationsMatchRegistrations:
        declaredTools.length === registeredTools.length &&
        declaredTools.every((tool, index) => tool === registeredTools[index]),
      sourceFiles: [
        'src/mcp/tools/tool-names.ts',
        'src/mcp/tools/index.ts',
        'src/mcp/tools/*.ts',
      ],
    },
    cli: {
      commands: extractCliCommands(cliSource),
      options: extractCliOptions(cliSource),
      initConfigSurfaces: {
        writesMcpJson: initSource.includes('writeMcpJson(projectPath)'),
        writesCodexConfig: initSource.includes('writeCodexConfig(projectPath)'),
        writesOpenCodeConfig: initSource.includes('mergeOpenCodeConfig(projectPath)'),
        hasPlaywrightAgentConfigs: initSource.includes('addPlaywrightAgentConfigs'),
      },
      sourceFiles: ['src/cli/index.ts', 'src/cli/init.ts', 'Makefile', 'package.json'],
    },
    runtime: {
      defaultJobTimeoutMinutes: extractNumberConstant(runtimeSource, 'DEFAULT_JOB_TIMEOUT_MINUTES'),
      defaultMaxRetriesExpression: extractDefaultMaxRetries(runtimeSource),
      sourceFiles: ['src/core/runtime-config.ts', 'src/core/state-store.ts', 'src/core/migrations.ts'],
    },
    adapters: {
      claude: {
        source: 'src/adapters/claude-adapter.ts',
        command: 'claude --print --output-format json',
      },
      codex: {
        source: 'src/adapters/codex-adapter.ts',
        command: 'codex exec --sandbox workspace-write',
      },
      opencode: {
        source: 'src/adapters/opencode-adapter.ts',
        command: 'opencode run --format json',
      },
    },
    skills: {
      phaseFiles: uniquePhaseFiles,
      phaseCount: uniquePhaseFiles.length,
      sourceFiles: ['skills/tenet/SKILL.md', 'skills/tenet/phases/*.md', 'skills/tenet-diagnose/SKILL.md'],
    },
  };
};

export const buildReviewerPrompt = ({ repoRoot, documents, codeFacts, scope }) => `You are a read-only documentation/code consistency reviewer for the Tenet repository.

Goal:
- Check whether current authoritative Markdown documents match actual code behavior.
- This is NOT a general code-quality review.
- Do not edit files, stage files, run formatters, or apply fixes.
- Report only doc/code contract drift: stale tool names, wrong counts, wrong defaults, wrong CLI behavior, stale config behavior, stale release/testing instructions, or unsupported markdown claims.

Repository root:
${repoRoot}

Reviewed Markdown scope:
${scope}

Documents to review:
${documents.map((doc) => `- ${doc}`).join('\n')}

Code fact summary extracted before this review:
${JSON.stringify(codeFacts, null, 2)}

Instructions:
1. Inspect the listed Markdown and the relevant source files when needed.
2. Treat code and tests as source of truth for behavior.
3. Ignore historical design drift in docs/planning unless scope is "all".
4. Prefer concrete evidence with file paths. Include line numbers when you can find them.
5. If a claim is ambiguous but not wrong, use severity "info".
6. Return ONLY one JSON object. Do not wrap it in Markdown.

Required JSON shape:
{
  "summary": "short review summary",
  "findings": [
    {
      "id": "stable-short-id",
      "title": "short finding title",
      "severity": "blocking|warning|info",
      "category": "tool_list_drift|runtime_default_drift|cli_doc_drift|skill_doc_drift|release_doc_drift|test_doc_drift|other",
      "doc_paths": ["README.md"],
      "code_paths": ["src/mcp/tools/tool-names.ts"],
      "doc_claim": "what the docs say",
      "code_evidence": "what the code says",
      "recommendation": "what should be changed",
      "confidence": "high|medium|low"
    }
  ]
}

If no issues are found, return {"summary":"No doc/code consistency issues found.","findings":[]}.`;

export const buildSynthesisPrompt = ({ reviewerResults, rawFindings }) => {
  const reviewers = reviewerResults.map((result) => ({
    reviewer: result.reviewer,
    summary: result.summary,
    finding_count: result.findings.length,
  }));

  return `You are the final synthesizer for Tenet doc/code consistency review.

Goal:
- Group duplicate or overlapping raw findings into canonical merged issues.
- Preserve source attribution and do not invent new issues.
- This is NOT a fresh review. You may only use the raw findings provided below.

Rules:
1. Every raw finding source_id MUST appear in exactly one merged issue.
2. Do not create a merged issue without at least one source_id.
3. If two findings describe the same underlying doc/code drift, group them together.
4. If findings are related but require different fixes, keep them separate.
5. Use the highest source severity in a group as the merged severity.
6. Preserve all reviewers in reported_by.
7. Return ONLY one JSON object. Do not wrap it in Markdown.

Reviewer summaries:
${JSON.stringify(reviewers, null, 2)}

Raw findings:
${JSON.stringify(rawFindings, null, 2)}

Required JSON shape:
{
  "summary": "short synthesis summary",
  "merged_issues": [
    {
      "id": "stable-short-id",
      "title": "canonical issue title",
      "severity": "blocking|warning|info",
      "category": "tool_list_drift|runtime_default_drift|cli_doc_drift|skill_doc_drift|release_doc_drift|test_doc_drift|other",
      "summary": "what the grouped issue means",
      "recommended_action": "what should be changed",
      "source_findings": ["claude:readme-tool-table", "codex:readme-mcp-table"],
      "merge_confidence": "high|medium|low",
      "severity_notes": "optional note when reviewers disagreed"
    }
  ]
}`;
};

const runProcess = ({ command, args, cwd, input, timeoutMs }) =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      resolve({
        success: false,
        stdout,
        stderr,
        error: error.message,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({
        success: code === 0 && !timedOut,
        stdout,
        stderr,
        error: timedOut ? `timed out after ${timeoutMs}ms` : code === 0 ? null : `exited with code ${code ?? 'unknown'}`,
        durationMs: Date.now() - startedAt,
      });
    });

    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });

const isCommandAvailable = (command) => {
  const result = spawnSync(command, ['--version'], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return result.status === 0;
};

const reviewerCommand = (agent, repoRoot) => {
  switch (agent) {
    case 'claude':
      return {
        command: 'claude',
        args: [
          '--print',
          '--output-format',
          'json',
          '--no-session-persistence',
          '--tools',
          'Read,Grep,Glob',
          '--allowedTools',
          'Read,Grep,Glob',
        ],
        inputMode: 'stdin',
      };
    case 'codex':
      return {
        command: 'codex',
        args: ['exec', '--sandbox', 'read-only', '--ephemeral', '--cd', repoRoot, '-'],
        inputMode: 'stdin',
      };
    case 'opencode':
      return {
        command: 'opencode',
        args: ['run', '--dir', repoRoot, '--format', 'json'],
        inputMode: 'argv',
      };
    default:
      throw new Error(`unknown agent: ${agent}`);
  }
};

export const invokeReviewer = async ({ agent, prompt, repoRoot, timeoutMs }) => {
  const spec = reviewerCommand(agent, repoRoot);
  if (!isCommandAvailable(spec.command)) {
    throw new Error(`${spec.command} CLI is not available`);
  }

  const args = spec.inputMode === 'argv' ? [...spec.args, prompt] : spec.args;
  const result = await runProcess({
    command: spec.command,
    args,
    cwd: repoRoot,
    input: spec.inputMode === 'stdin' ? prompt : null,
    timeoutMs,
  });

  return {
    agent,
    ...result,
  };
};

const asString = (value) => {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
};

const unwrapCliJson = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  for (const key of ['result', 'output', 'content', 'text', 'message']) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      return value[key];
    }
  }

  return value;
};

const findBalancedJsonObject = (text) => {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    if (depth === 0) {
      return text.slice(start, i + 1);
    }
  }
  return null;
};

export const parseJsonFromText = (text) => {
  const trimmed = asString(text).trim();
  if (!trimmed) {
    throw new Error('empty reviewer output');
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue.
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // Continue.
    }
  }

  const candidate = findBalancedJsonObject(trimmed);
  if (candidate) {
    return JSON.parse(candidate);
  }

  throw new Error('could not find JSON object in reviewer output');
};

export const parseReviewerOutput = (rawOutput, agent = 'unknown') => {
  const first = parseJsonFromText(rawOutput);
  const unwrapped = unwrapCliJson(first);
  const parsed = typeof unwrapped === 'string' ? parseJsonFromText(unwrapped) : unwrapped;
  return normalizeReviewerResult(parsed, agent);
};

const normalizeSeverity = (value) => {
  const severity = String(value ?? '').toLowerCase();
  if (severity === 'critical' || severity === 'high' || severity === 'error') return 'blocking';
  if (severity === 'medium' || severity === 'warn') return 'warning';
  if (SEVERITY_ORDER[severity]) return severity;
  return 'info';
};

const normalizeStringArray = (value) => {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).filter(Boolean);
};

export const normalizeReviewerResult = (value, agent = 'unknown') => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`reviewer ${agent} did not return an object`);
  }

  const findings = Array.isArray(value.findings) ? value.findings : [];
  return {
    reviewer: agent,
    summary: asString(value.summary || `Reviewer ${agent} completed.`),
    findings: findings.map((finding, index) => {
      const title = asString(finding.title || finding.id || `Finding ${index + 1}`);
      return {
        id: asString(finding.id || `${agent}-${index + 1}`).toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
        title,
        severity: normalizeSeverity(finding.severity),
        category: asString(finding.category || 'other'),
        doc_paths: normalizeStringArray(finding.doc_paths),
        code_paths: normalizeStringArray(finding.code_paths),
        doc_claim: asString(finding.doc_claim),
        code_evidence: asString(finding.code_evidence),
        recommendation: asString(finding.recommendation),
        confidence: ['high', 'medium', 'low'].includes(String(finding.confidence)) ? String(finding.confidence) : 'medium',
        reviewer: agent,
      };
    }),
  };
};

const findingSourceId = (finding) => `${finding.reviewer}:${finding.id}`;

export const addSourceIds = (findings) =>
  findings.map((finding, index) => ({
    ...finding,
    source_id: finding.source_id || findingSourceId(finding) || `${finding.reviewer}:finding-${index + 1}`,
  }));

const decisionSeverity = (severity) => {
  if (severity === 'blocking') return 'critical';
  if (severity === 'warning') return 'important';
  return 'consider';
};

const highestSeverity = (values) =>
  values.reduce((highest, current) =>
    SEVERITY_ORDER[normalizeSeverity(current)] > SEVERITY_ORDER[highest] ? normalizeSeverity(current) : highest,
  'info');

const uniqueSorted = (values) => [...new Set(values.filter(Boolean))].sort();

const slugify = (value, fallback) => {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
};

const buildSingletonIssue = (finding, index = 0) => ({
  id: slugify(finding.id || finding.title, `issue-${index + 1}`),
  title: finding.title,
  severity: finding.severity,
  category: finding.category,
  reported_by: [finding.reviewer],
  doc_paths: [...finding.doc_paths],
  code_paths: [...finding.code_paths],
  summary: `${finding.doc_claim || 'Documentation claim'} ${finding.code_evidence ? `Code evidence: ${finding.code_evidence}` : ''}`.trim(),
  recommended_action: finding.recommendation,
  source_findings: [finding.source_id],
  merge_confidence: 'high',
  severity_notes: '',
});

export const buildSingletonIssues = (rawFindings) =>
  rawFindings.map((finding, index) => buildSingletonIssue(finding, index));

export const normalizeSynthesisResult = (value, rawFindings) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('synthesizer did not return an object');
  }

  const rawById = new Map(rawFindings.map((finding) => [finding.source_id, finding]));
  const used = new Set();
  const mergedIssues = [];
  const candidateIssues = Array.isArray(value.merged_issues) ? value.merged_issues : [];

  for (const issue of candidateIssues) {
    const requestedSourceIds = normalizeStringArray(issue.source_findings);
    const sourceIds = [];
    for (const sourceId of requestedSourceIds) {
      if (rawById.has(sourceId) && !used.has(sourceId)) {
        used.add(sourceId);
        sourceIds.push(sourceId);
      }
    }

    if (sourceIds.length === 0) {
      continue;
    }

    const sources = sourceIds.map((sourceId) => rawById.get(sourceId));
    const sourceSeverity = highestSeverity(sources.map((source) => source.severity));

    mergedIssues.push({
      id: slugify(issue.id || issue.title || sources[0].title, `issue-${mergedIssues.length + 1}`),
      title: asString(issue.title || sources[0].title),
      severity: sourceSeverity,
      category: asString(issue.category || sources[0].category || 'other'),
      reported_by: uniqueSorted(sources.map((source) => source.reviewer)),
      doc_paths: uniqueSorted(sources.flatMap((source) => source.doc_paths)),
      code_paths: uniqueSorted(sources.flatMap((source) => source.code_paths)),
      summary: asString(issue.summary || sources.map((source) => source.doc_claim).filter(Boolean).join(' ')),
      recommended_action: asString(issue.recommended_action || sources.map((source) => source.recommendation).filter(Boolean).join(' ')),
      source_findings: sourceIds,
      merge_confidence: ['high', 'medium', 'low'].includes(String(issue.merge_confidence)) ? String(issue.merge_confidence) : 'medium',
      severity_notes: asString(issue.severity_notes || ''),
    });
  }

  for (const finding of rawFindings) {
    if (!used.has(finding.source_id)) {
      mergedIssues.push(buildSingletonIssue(finding, mergedIssues.length));
    }
  }

  return {
    summary: asString(value.summary || `Synthesized ${rawFindings.length} raw finding(s) into ${mergedIssues.length} issue(s).`),
    merged_issues: mergedIssues,
  };
};

export const parseSynthesisOutput = (rawOutput, rawFindings) => {
  const first = parseJsonFromText(rawOutput);
  const unwrapped = unwrapCliJson(first);
  const parsed = typeof unwrapped === 'string' ? parseJsonFromText(unwrapped) : unwrapped;
  return normalizeSynthesisResult(parsed, rawFindings);
};

const recommendedOption = (finding) => {
  const recommendation = `${finding.recommended_action ?? finding.recommendation} ${finding.title}`.toLowerCase();
  if (recommendation.includes('code')) return 'fix-code';
  if (recommendation.includes('defer')) return 'defer';
  return 'fix-docs';
};

export const buildDecisionReport = ({
  repoRoot,
  scope,
  documents,
  codeFacts,
  reviewerResults,
  mergedIssues,
  synthesis = null,
  toolErrors = [],
  generatedAt = new Date().toISOString(),
}) => {
  const findings = addSourceIds(reviewerResults.flatMap((result) => result.findings));
  const issues = mergedIssues ?? buildSingletonIssues(findings);
  const reviewers = reviewerResults.map((result) => ({
    reviewer: result.reviewer,
    summary: result.summary,
    finding_count: result.findings.length,
  }));

  const decisions = issues.length > 0
    ? issues.map((issue, index) => ({
      id: issue.id || `issue-${index + 1}`,
      question: `How should Tenet resolve this doc/code inconsistency: ${issue.title}?`,
      oneLineSummary: issue.title.slice(0, 60),
      severity: decisionSeverity(issue.severity),
      background: `Reported by ${issue.reported_by.join(', ')} as ${issue.category}. Docs: ${issue.doc_paths.join(', ') || 'unspecified'}. Code: ${issue.code_paths.join(', ') || 'unspecified'}.`,
      implication: issue.severity === 'blocking'
        ? 'If this remains, agents or maintainers can follow stale instructions and debug the wrong layer.'
        : 'If this remains, documentation trust degrades and future changes become harder to review.',
      recommended: recommendedOption(issue),
      options: [
        {
          id: 'fix-docs',
          label: 'Fix Docs',
          description: `Update the referenced Markdown so it matches the code evidence. ${issue.summary}`,
          pros: ['Fastest path when code is source of truth', 'Reduces prompt and runbook drift'],
          cons: ['Does not change runtime behavior'],
          effort: 'low',
        },
        {
          id: 'fix-code',
          label: 'Fix Code',
          description: 'Change code behavior if the documented claim is the intended contract.',
          pros: ['Preserves the documented contract when docs are right'],
          cons: ['Requires implementation and normal tests'],
          effort: 'medium',
        },
        {
          id: 'defer',
          label: 'Defer',
          description: `Leave this inconsistency in place for now and record why it is acceptable. Source findings: ${issue.source_findings.join(', ')}.`,
          pros: ['Avoids churn when the claim is intentionally transitional'],
          cons: ['Leaves future reviewers with known drift'],
          effort: 'low',
        },
      ],
    }))
    : [
      {
        id: 'no-inconsistencies-found',
        question: 'No doc/code consistency issues were found. What should happen next?',
        oneLineSummary: 'No inconsistencies found',
        severity: 'consider',
        background: 'The selected reviewers did not report inconsistencies in the current authoritative document set.',
        implication: 'No immediate action is required, but future code or docs changes can still introduce drift.',
        recommended: 'keep-current',
        options: [
          {
            id: 'keep-current',
            label: 'Keep Current',
            description: 'Accept the report and make no documentation changes.',
            pros: ['No unnecessary churn', 'Matches the reviewer result'],
            cons: ['Limited to the selected scope and agents'],
            effort: 'low',
          },
          {
            id: 'broaden-scope',
            label: 'Broaden Scope',
            description: 'Run again with all Markdown or more reviewers.',
            pros: ['More coverage'],
            cons: ['More time, cost, and historical-doc noise'],
            effort: 'medium',
          },
        ],
      },
    ];

  return {
    version: '1.0',
    title: 'Tenet Doc/Code Consistency Review',
    summary: `${reviewerResults.length} reviewer(s) checked ${documents.length} document(s) against code-derived facts and reported ${findings.length} raw finding(s), synthesized into ${issues.length} issue(s).`,
    context: [
      {
        heading: 'Review Boundary',
        body: 'This report checks whether authoritative Markdown matches code behavior. It is not a general code-quality review.',
      },
      {
        heading: 'Code Facts',
        body: `MCP tools declared/registered: ${codeFacts.mcp.declaredCount}/${codeFacts.mcp.registeredCount}. Package version: ${codeFacts.package.version}. Default timeout: ${codeFacts.runtime.defaultJobTimeoutMinutes} minutes.`,
      },
    ],
    diagram: 'flowchart LR\n  Docs[Authoritative Markdown] --> Review[AI consistency review]\n  Code[Code-derived facts] --> Review\n  Review --> Report[Cognition JSON + Markdown]',
    decisions,
    notes: [
      ...reviewers.map((reviewer) => `${reviewer.reviewer}: ${reviewer.finding_count} finding(s). ${reviewer.summary}`),
      synthesis ? `synthesis: ${synthesis.summary}` : 'synthesis: disabled; raw findings were converted to singleton issues.',
    ].join('\n'),
    metadata: {
      generated_at: generatedAt,
      repo_root: repoRoot,
      scope,
      documents,
      reviewers,
      synthesis,
      merged_issues: issues,
      raw_findings: findings,
      findings,
      tool_errors: toolErrors,
    },
  };
};

const findingSort = (a, b) => {
  const severityDelta = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
  if (severityDelta !== 0) return severityDelta;
  return a.title.localeCompare(b.title);
};

export const renderMarkdownReport = (report) => {
  const issues = [...(report.metadata?.merged_issues ?? report.metadata?.findings ?? [])].sort(findingSort);
  const rawFindings = report.metadata?.raw_findings ?? report.metadata?.findings ?? [];
  const reviewers = report.metadata?.reviewers ?? [];
  const lines = [
    '# Tenet Doc/Code Consistency Review',
    '',
    report.summary,
    '',
    `- Generated: ${report.metadata?.generated_at ?? 'unknown'}`,
    `- Scope: ${report.metadata?.scope ?? 'unknown'}`,
    `- Reviewers: ${reviewers.map((reviewer) => reviewer.reviewer).join(', ') || 'none'}`,
    `- Documents reviewed: ${(report.metadata?.documents ?? []).length}`,
    '',
    '## Merged Issues',
    '',
  ];

  if (issues.length === 0) {
    lines.push('No doc/code consistency findings reported.');
  } else {
    for (const issue of issues) {
      lines.push(`### ${issue.severity.toUpperCase()}: ${issue.title}`);
      lines.push('');
      lines.push(`- Reported by: ${issue.reported_by?.join(', ') || '(unknown)'}`);
      lines.push(`- Category: ${issue.category}`);
      lines.push(`- Merge confidence: ${issue.merge_confidence || '(not provided)'}`);
      lines.push(`- Docs: ${issue.doc_paths?.join(', ') || '(unspecified)'}`);
      lines.push(`- Code: ${issue.code_paths?.join(', ') || '(unspecified)'}`);
      lines.push(`- Summary: ${issue.summary || '(not provided)'}`);
      lines.push(`- Recommendation: ${issue.recommended_action || '(not provided)'}`);
      lines.push(`- Source findings: ${issue.source_findings?.join(', ') || '(not provided)'}`);
      if (issue.severity_notes) {
        lines.push(`- Severity notes: ${issue.severity_notes}`);
      }
      lines.push('');
    }
  }

  lines.push('## Raw Findings');
  lines.push('');
  if (rawFindings.length === 0) {
    lines.push('No raw reviewer findings reported.');
  } else {
    for (const finding of rawFindings) {
      lines.push(`- ${finding.source_id || findingSourceId(finding)} (${finding.reviewer}, ${finding.severity}): ${finding.title}`);
    }
  }
  lines.push('');

  lines.push('## Reviewer Summaries');
  lines.push('');
  for (const reviewer of reviewers) {
    lines.push(`- ${reviewer.reviewer}: ${reviewer.finding_count} finding(s). ${reviewer.summary}`);
  }
  if (report.metadata?.synthesis) {
    lines.push(`- synthesis: ${report.metadata.synthesis.summary}`);
  }

  return `${lines.join('\n')}\n`;
};

const ensureParentDir = (filePath) => {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
};

export const shouldFail = (report, failOn) => {
  const findings = report.metadata?.merged_issues ?? report.metadata?.findings ?? [];
  if (failOn === 'never') return false;
  if (failOn === 'any') return findings.length > 0;
  return findings.some((finding) => finding.severity === 'blocking');
};

export const runDocsReview = async (options) => {
  const repoRoot = options.repoRoot ?? findRepoRoot();
  const documents = getReviewDocuments(repoRoot, options.scope);
  const codeFacts = extractCodeFacts(repoRoot);
  const prompt = buildReviewerPrompt({ repoRoot, documents, codeFacts, scope: options.scope });
  const timeoutMs = options.timeoutMinutes * 60 * 1000;
  const reviewerResults = [];
  const toolErrors = [];

  for (const agent of options.agents) {
    const invocation = await invokeReviewer({ agent, prompt, repoRoot, timeoutMs });
    if (!invocation.success) {
      toolErrors.push({
        reviewer: agent,
        kind: 'invocation_failed',
        detail: invocation.error || invocation.stderr || invocation.stdout || 'unknown error',
      });
      reviewerResults.push({
        reviewer: agent,
        summary: `${agent} reviewer failed: ${invocation.error || invocation.stderr || 'unknown error'}`,
        findings: [
          {
            id: `${agent}-reviewer-failed`,
            title: `${agent} reviewer failed`,
            severity: 'blocking',
            category: 'reviewer_invocation_failed',
            doc_paths: [],
            code_paths: [],
            doc_claim: 'The docs review expected this reviewer to complete.',
            code_evidence: invocation.stderr || invocation.stdout || invocation.error || 'No reviewer output.',
            recommendation: `Fix the ${agent} CLI/auth/configuration and rerun docs review.`,
            confidence: 'high',
            reviewer: agent,
          },
        ],
      });
      continue;
    }

    try {
      reviewerResults.push(parseReviewerOutput(invocation.stdout, agent));
    } catch (error) {
      toolErrors.push({
        reviewer: agent,
        kind: 'output_parse_failed',
        detail: error instanceof Error ? error.message : String(error),
      });
      reviewerResults.push({
        reviewer: agent,
        summary: `${agent} reviewer output could not be parsed.`,
        findings: [
          {
            id: `${agent}-output-parse-failed`,
            title: `${agent} reviewer output parse failed`,
            severity: 'blocking',
            category: 'reviewer_output_parse_failed',
            doc_paths: [],
            code_paths: [],
            doc_claim: 'Reviewer output should match the docs-review JSON contract.',
            code_evidence: error instanceof Error ? error.message : String(error),
            recommendation: 'Tighten the reviewer prompt/parser or rerun the reviewer.',
            confidence: 'high',
            reviewer: agent,
          },
        ],
      });
    }
  }

  const rawFindings = addSourceIds(reviewerResults.flatMap((result) => result.findings));
  let synthesis = null;
  let mergedIssues = buildSingletonIssues(rawFindings);

  if (rawFindings.length > 0 && options.synthesizer !== 'none') {
    const synthesisPrompt = buildSynthesisPrompt({ reviewerResults, rawFindings });
    const invocation = await invokeReviewer({
      agent: options.synthesizer,
      prompt: synthesisPrompt,
      repoRoot,
      timeoutMs,
    });

    if (!invocation.success) {
      toolErrors.push({
        reviewer: options.synthesizer,
        kind: 'synthesis_invocation_failed',
        detail: invocation.error || invocation.stderr || invocation.stdout || 'unknown error',
      });
      synthesis = {
        synthesizer: options.synthesizer,
        summary: `${options.synthesizer} synthesis failed; raw findings were converted to singleton issues.`,
        error: invocation.error || invocation.stderr || invocation.stdout || 'unknown error',
      };
    } else {
      try {
        const parsedSynthesis = parseSynthesisOutput(invocation.stdout, rawFindings);
        synthesis = {
          synthesizer: options.synthesizer,
          summary: parsedSynthesis.summary,
        };
        mergedIssues = parsedSynthesis.merged_issues;
      } catch (error) {
        toolErrors.push({
          reviewer: options.synthesizer,
          kind: 'synthesis_output_parse_failed',
          detail: error instanceof Error ? error.message : String(error),
        });
        synthesis = {
          synthesizer: options.synthesizer,
          summary: `${options.synthesizer} synthesis output could not be parsed; raw findings were converted to singleton issues.`,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  } else if (rawFindings.length === 0) {
    synthesis = {
      synthesizer: options.synthesizer,
      summary: 'No raw findings to synthesize.',
    };
  } else {
    synthesis = {
      synthesizer: 'none',
      summary: 'Synthesis disabled; raw findings were converted to singleton issues.',
    };
  }

  const report = buildDecisionReport({
    repoRoot,
    scope: options.scope,
    documents,
    codeFacts,
    reviewerResults,
    mergedIssues,
    synthesis,
    toolErrors,
  });
  const markdown = renderMarkdownReport(report);

  if (options.jsonOut) {
    ensureParentDir(options.jsonOut);
    fs.writeFileSync(options.jsonOut, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  if (options.markdownOut) {
    ensureParentDir(options.markdownOut);
    fs.writeFileSync(options.markdownOut, markdown, 'utf8');
  }

  if (options.print) {
    process.stdout.write(markdown);
  }

  return { report, markdown, exitCode: toolErrors.length > 0 || shouldFail(report, options.failOn) ? 1 : 0 };
};

const printHelp = () => {
  process.stdout.write(`Usage: pnpm docs:review -- [options]

Options:
  --agents <list>              Comma-separated reviewers: claude,codex,opencode (default: claude)
  --synthesizer <agent|none>   Final merge agent for duplicate findings (default: claude)
  --scope current|all          Markdown scope to review (default: current)
  --json-out <path>            Save cognition-alignment JSON report
  --markdown-out <path>        Save human-readable Markdown report
  --no-print                   Do not print Markdown to stdout
  --fail-on blocking|any|never Exit nonzero on selected finding level (default: blocking)
  --timeout-minutes <n>        Per-reviewer timeout (default: ${DEFAULT_TIMEOUT_MINUTES})
  --repo-root <path>           Override repository root
`);
};

const isMain = () => {
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
  return entry === fileURLToPath(import.meta.url);
};

if (isMain()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
      process.exit(0);
    }
    const result = await runDocsReview(options);
    process.exitCode = result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`docs-review: ${message}\n`);
    process.exitCode = 1;
  }
}

export { REVIEWER_OUTPUT_SCHEMA };
