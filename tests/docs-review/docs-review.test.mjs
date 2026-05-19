import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDecisionReport,
  buildSingletonIssues,
  extractCodeFacts,
  getReviewDocuments,
  normalizeSynthesisResult,
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
      '--synthesizer',
      'codex',
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
    expect(options.synthesizer).toBe('codex');
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
            doc_evidence: [
              {
                path: 'README.md',
                line: 154,
                quote: '16 MCP tools',
                claim: 'README says the tool list has 16 tools.',
              },
            ],
            code_evidence_details: [
              {
                path: 'src/mcp/tools/tool-names.ts',
                line: 10,
                symbol: 'TENET_MCP_TOOL_NAMES',
                actual_behavior: 'The array contains 18 tools.',
              },
            ],
            suggested_changes: [
              {
                file: 'README.md',
                line: 154,
                before: '16 MCP tools',
                after: '18 MCP tools',
                why: 'TENET_MCP_TOOL_NAMES has 18 entries.',
              },
            ],
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
    expect(result.findings[0].doc_evidence[0].line).toBe(154);
    expect(result.findings[0].code_evidence_details[0].symbol).toBe('TENET_MCP_TOOL_NAMES');
    expect(result.findings[0].suggested_changes[0].after).toBe('18 MCP tools');
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
            doc_evidence: [
              {
                path: 'README.md',
                line: 42,
                quote: '30 minutes',
                claim: 'README states the default timeout is 30 minutes.',
              },
            ],
            code_evidence_details: [
              {
                path: 'src/core/runtime-config.ts',
                line: 5,
                symbol: 'DEFAULT_JOB_TIMEOUT_MINUTES',
                actual_behavior: 'The default timeout is 120 minutes.',
              },
            ],
            suggested_changes: [
              {
                file: 'README.md',
                line: 42,
                before: '30 minutes',
                after: '120 minutes',
                why: 'DEFAULT_JOB_TIMEOUT_MINUTES is 120.',
              },
            ],
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
    expect(report.decisions[0].options[0].changes[0]).toMatchObject({
      file: 'README.md:42',
      before: '30 minutes',
      after: '120 minutes',
    });
    expect(report.metadata.reviewers[0].reviewer).toBe('claude');
    expect(report.metadata.raw_findings[0].source_id).toBe('claude:timeout');
    expect(report.metadata.merged_issues[0].source_findings).toEqual(['claude:timeout']);
    expect(markdown).toContain('Timeout default claim is stale');
    expect(markdown).toContain('DEFAULT_JOB_TIMEOUT_MINUTES');
    expect(markdown).toContain('Suggested changes');
    expect(shouldFail(report, 'blocking')).toBe(false);
    expect(shouldFail(report, 'any')).toBe(true);
  });

  it('normalizes synthesis output and preserves unmerged raw findings', () => {
    const rawFindings = [
      ...normalizeReviewerResult({
        summary: 'claude',
        findings: [
          {
            id: 'readme-tools',
            title: 'README tool table is stale',
            severity: 'warning',
            category: 'tool_list_drift',
            doc_paths: ['README.md'],
            code_paths: ['src/mcp/tools/tool-names.ts'],
            doc_claim: 'README lists 16 tools.',
            code_evidence: 'Code declares 18 tools.',
            doc_evidence: [{ path: 'README.md', line: 154, quote: '16 tools' }],
            code_evidence_details: [{ path: 'src/mcp/tools/tool-names.ts', line: 10, symbol: 'TENET_MCP_TOOL_NAMES' }],
            suggested_changes: [{ file: 'README.md', line: 154, before: '16 tools', after: '18 tools' }],
            recommendation: 'Update README table.',
            confidence: 'high',
          },
        ],
      }, 'claude').findings,
      ...normalizeReviewerResult({
        summary: 'codex',
        findings: [
          {
            id: 'mcp-table',
            title: 'README MCP table omits tools',
            severity: 'info',
            category: 'tool_list_drift',
            doc_paths: ['README.md'],
            code_paths: ['src/mcp/tools/index.ts'],
            doc_claim: 'README table is complete.',
            code_evidence: 'Two tools are missing.',
            recommendation: 'Add missing tools.',
            confidence: 'medium',
          },
          {
            id: 'phase-count',
            title: 'README says seven phases',
            severity: 'info',
            category: 'skill_doc_drift',
            doc_paths: ['README.md'],
            code_paths: ['skills/tenet/SKILL.md'],
            doc_claim: 'Seven phases.',
            code_evidence: 'Eight phase files.',
            recommendation: 'Update phase count.',
            confidence: 'high',
          },
        ],
      }, 'codex').findings,
    ].map((finding) => ({
      ...finding,
      source_id: `${finding.reviewer}:${finding.id}`,
    }));

    const synthesis = normalizeSynthesisResult({
      summary: 'Grouped duplicate tool table findings.',
      merged_issues: [
        {
          id: 'readme-mcp-tool-table',
          title: 'README MCP tool table is stale',
          severity: 'info',
          category: 'tool_list_drift',
          summary: 'Both reviewers found the same stale README table.',
          recommended_action: 'Update README MCP table.',
          source_findings: ['claude:readme-tools', 'codex:mcp-table'],
          merge_confidence: 'high',
        },
      ],
    }, rawFindings);

    expect(synthesis.merged_issues).toHaveLength(2);
    expect(synthesis.merged_issues[0].reported_by).toEqual(['claude', 'codex']);
    expect(synthesis.merged_issues[0].severity).toBe('warning');
    expect(synthesis.merged_issues[0].doc_evidence[0].quote).toBe('16 tools');
    expect(synthesis.merged_issues[0].suggested_changes[0].after).toBe('18 tools');
    expect(synthesis.merged_issues[1].source_findings).toEqual(['codex:phase-count']);
    expect(buildSingletonIssues(rawFindings)).toHaveLength(3);
  });
});
