import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDecisionReport,
  extractCodeFacts,
  getReviewDocuments,
  normalizeReviewerResult,
  parseArgs,
  parseJsonFromText,
  parseReviewerOutput,
  renderMarkdownReport,
  shouldFail,
} from '../../scripts/docs-review.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('docs-review repo maintenance tool', () => {
  it('parses command line options', () => {
    const options = parseArgs([
      '--agents',
      'claude-code,codex',
      '--scope',
      'all',
      '--json-out',
      '/tmp/report.json',
      '--markdown-out=/tmp/report.md',
      '--no-print',
      '--fail-on',
      'any',
      '--timeout-minutes',
      '7',
    ]);

    expect(options.agents).toEqual(['claude', 'codex']);
    expect(options.scope).toBe('all');
    expect(options.jsonOut).toBe('/tmp/report.json');
    expect(options.markdownOut).toBe('/tmp/report.md');
    expect(options.print).toBe(false);
    expect(options.failOn).toBe('any');
    expect(options.timeoutMinutes).toBe(7);
  });

  it('selects current authoritative docs without historical planning docs', () => {
    const documents = getReviewDocuments(repoRoot, 'current');

    expect(documents).toContain('README.md');
    expect(documents).toContain('CLAUDE.md');
    expect(documents).toContain('skills/tenet/SKILL.md');
    expect(documents).not.toContain('docs/planning/01_initial_prd.md');
  });

  it('extracts code facts from current source files', () => {
    const facts = extractCodeFacts(repoRoot);

    expect(facts.package.name).toBe('@jeikeilim/tenet');
    expect(facts.mcp.declaredTools).toContain('tenet_start_job');
    expect(facts.mcp.registeredTools).toContain('tenet_start_job');
    expect(facts.mcp.declarationsMatchRegistrations).toBe(true);
    expect(facts.runtime.defaultJobTimeoutMinutes).toBe(120);
    expect(facts.cli.commands).toEqual(expect.arrayContaining(['init', 'serve', 'status', 'config']));
    expect(facts.skills.phaseFiles).toContain('phases/05-execution-loop.md');
  });

  it('parses fenced reviewer JSON', () => {
    const parsed = parseJsonFromText(`Review result:

\`\`\`json
{"summary":"ok","findings":[]}
\`\`\`
`);

    expect(parsed.summary).toBe('ok');
    expect(parsed.findings).toEqual([]);
  });

  it('unwraps Claude-style JSON output and normalizes findings', () => {
    const output = JSON.stringify({
      result: JSON.stringify({
        summary: 'Found stale docs.',
        findings: [
          {
            id: 'tool-count',
            title: 'README tool table is stale',
            severity: 'high',
            category: 'tool_list_drift',
            doc_paths: ['README.md'],
            code_paths: ['src/mcp/tools/tool-names.ts'],
            doc_claim: 'The table lists 16 tools.',
            code_evidence: 'TENET_MCP_TOOL_NAMES has 18 tools.',
            recommendation: 'Fix the docs table.',
            confidence: 'high',
          },
        ],
      }),
    });

    const result = parseReviewerOutput(output, 'claude');

    expect(result.reviewer).toBe('claude');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('blocking');
  });

  it('builds cognition-alignment compatible JSON and Markdown', () => {
    const reviewerResults = [
      normalizeReviewerResult({
        summary: 'One issue.',
        findings: [
          {
            id: 'timeout',
            title: 'Timeout default claim is stale',
            severity: 'warning',
            category: 'runtime_default_drift',
            doc_paths: ['README.md'],
            code_paths: ['src/core/runtime-config.ts'],
            doc_claim: 'Default is 30 minutes.',
            code_evidence: 'DEFAULT_JOB_TIMEOUT_MINUTES is 120.',
            recommendation: 'Fix docs to say 120 minutes.',
            confidence: 'high',
          },
        ],
      }, 'claude'),
    ];

    const report = buildDecisionReport({
      repoRoot,
      scope: 'current',
      documents: ['README.md'],
      codeFacts: extractCodeFacts(repoRoot),
      reviewerResults,
      generatedAt: '2026-05-11T00:00:00.000Z',
    });
    const markdown = renderMarkdownReport(report);

    expect(report.version).toBe('1.0');
    expect(report.decisions[0].options.map((option) => option.id)).toEqual(['fix-docs', 'fix-code', 'defer']);
    expect(report.metadata.reviewers[0].reviewer).toBe('claude');
    expect(markdown).toContain('Timeout default claim is stale');
    expect(shouldFail(report, 'blocking')).toBe(false);
    expect(shouldFail(report, 'any')).toBe(true);
  });
});
