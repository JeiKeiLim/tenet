import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The finding-category dispatch in 05-execution-loop.md is agent-executed decision
// logic (the orchestrator reads the skill, not Tenet code), so it cannot be unit
// tested the way tool handlers are, and a content test cannot pin control flow.
// These assertions pin the invariants that ARE textually checkable and that have
// regressed repeatedly across review rounds: the escalation gate and the blocking
// filter must use the SAME exclusion set, the contention steer must precede the
// report-only gate and be a context note (not a command), the report-only gate
// must precede the retry branch, the followup must name all blocking categories,
// and the retry path must label details with their category.

const here = path.dirname(fileURLToPath(import.meta.url));
const skillPath = path.resolve(here, '..', '..', 'skills', 'tenet', 'phases', '05-execution-loop.md');
const evalPath = path.resolve(here, '..', '..', 'skills', 'tenet', 'phases', '06-evaluation.md');
const criticsPath = path.resolve(here, '..', '..', 'skills', 'tenet', 'critics.md');
const doc = fs.readFileSync(skillPath, 'utf8');
const evalDoc = fs.readFileSync(evalPath, 'utf8');
const criticsDoc = fs.readFileSync(criticsPath, 'utf8');

// Shared normalization for an exclusion-set capture: whitespace- and
// trailing-comma-normalized, compared as a set (order is irrelevant for a
// membership check). Shared so the fixture exercises the SAME path as the real
// extraction.
const normalizeExclusionSet = (raw: string): string[] =>
  raw
    .replace(/\s+/g, ' ')
    .replace(/,\s*$/, '')
    .trim()
    .split(',')
    .map((x) => x.trim())
    .sort();

describe('skill finding-category dispatch contract', () => {
  it('uses the SAME exclusion set in the report-only gate and the blocking filter', () => {
    // Extract every `f.category not in (...)` set; the gate and the filter must
    // agree, or a report-only job with an unknown category falls to a doomed retry.
    // The pattern is specific enough that it only appears in the two real sets
    // (a comment would need to contain the exact code text). Whitespace- and
    // trailing-comma-normalized, and compared as a set (order is irrelevant for
    // a membership check).
    const sets = [...doc.matchAll(/f\.category not in \(([^)]*)\)/g)].map((m) =>
      normalizeExclusionSet(m[1]),
    );
    expect(sets.length).toBeGreaterThanOrEqual(2);
    // The invariant is that the gate and the filter AGREE; also pin the expected
    // set so a wrong-but-agreeing set is caught.
    for (const s of sets) {
      expect(s).toEqual(['"contention"', '"evidence_mismatch"']);
    }
  });

  it('normalizes a multi-line trailing-comma exclusion set (fixture for the strip)', () => {
    // The current doc is single-line, so the /,\s*$/ strip is unexercised by the
    // real fixture. Pin the SHARED normalization directly so a regression to
    // /,+$/ in the real extraction path is caught.
    expect(normalizeExclusionSet('\n    "evidence_mismatch",\n    "contention",\n')).toEqual([
      '"contention"',
      '"evidence_mismatch"',
    ]);
  });

  it('fires the contention steer as a context NOTE inside the guard, before the report-only gate', () => {
    // The steer must be guarded on contention (and INSIDE the guard block, not
    // dedented out of it), be class="context" (a note, not a command — no MCP tool
    // can set eval_parallel_safe), and precede the report_only gate so a
    // higher-priority category cannot skip it on either path.
    const guardMatch = doc.match(/\n +if any\(f\.category == "contention"/);
    const steerMatch = doc.match(/\n +tenet_add_steer\(content=f"contention detected in eval/);
    const gateMatch = doc.match(/\n +if source_job\.params\.report_only/);
    expect(guardMatch).not.toBeNull();
    expect(steerMatch).not.toBeNull();
    expect(gateMatch).not.toBeNull();
    const guardIdx = guardMatch ? guardMatch.index ?? -1 : -1;
    const steerIdx = steerMatch ? steerMatch.index ?? -1 : -1;
    const gateIdx = gateMatch ? gateMatch.index ?? -1 : -1;
    expect(guardIdx).toBeLessThan(steerIdx);
    expect(steerIdx).toBeLessThan(gateIdx);
    // The steer must be indented deeper than the guard (inside its block).
    // guardIdx and steerIdx point at the '\n' before their lines, so each line
    // runs from idx+1 to the next '\n'.
    const guardLine = doc.slice(guardIdx + 1, doc.indexOf('\n', guardIdx + 1));
    const steerLine = doc.slice(steerIdx + 1, doc.indexOf('\n', steerIdx + 1));
    const guardIndent = guardLine.match(/^ */)?.[0].length ?? 0;
    const steerIndent = steerLine.match(/^ */)?.[0].length ?? 0;
    expect(steerIndent).toBeGreaterThan(guardIndent);
    // The steer call must carry class="context" as an actual argument — anchored
    // to the argument form (", class=\"context\"") which tolerates trailing
    // arguments (e.g. affected_job_ids). This is best-effort: a contrived comment
    // containing the exact substring could still satisfy it, but the realistic
    // gaps are closed. Note: the anchor above pins the message prefix AND that
    // content= is the first argument, so a message rewording or argument reorder
    // requires updating this test too.
    expect(steerLine).toContain(', class="context"');
  });

  it('pins the 06 contention row invariants and their order', () => {
    // The 06 finding-categories table is the canonical routing reference and its
    // contention row has regressed repeatedly (wrong-condition negation, missing
    // steer step, missing read-back). Pin the load-bearing contingency chain IN
    // ORDER (steer -> read-back -> retry -> if recurs -> re-run readiness -> wait
    // -> re-run eval -> report to user). The escalate qualifier must sit after
    // the steer/read-back and before the parallel-mode recursion (it is part of
    // the retry decision, not the terminal action), but its order relative to the
    // retry verb is a phrasing choice. The OR'd report triggers must precede the
    // report action (their relative order is arbitrary).
    const row = evalDoc.split('\n').find((l) => l.startsWith('| `contention` |'));
    expect(row).toBeDefined();
    const ordered = [
      'context steer',
      'tenet_process_steer',
      'retry the source job',
      'if it recurs in parallel mode',
      'tenet_validate_readiness',
      'wait for it to complete',
      're-run the eval',
      'report it to the user',
    ];
    let prev = -1;
    for (const s of ordered) {
      const idx = row!.indexOf(s);
      expect(idx).toBeGreaterThan(prev);
      prev = idx;
    }
    // Escalate qualifier: after the steer/read-back, before the recursion.
    const escalateIdx = row!.indexOf('escalate instead');
    const steerIdx = row!.indexOf('tenet_process_steer');
    const recursIdx = row!.indexOf('if it recurs in parallel mode');
    expect(escalateIdx).toBeGreaterThan(steerIdx);
    expect(escalateIdx).toBeLessThan(recursIdx);
    expect(row).toContain('if a blocking category coexists on a report-only job, escalate instead');
    // The OR'd report triggers must follow the eval re-run and precede the report
    // action (their relative order is arbitrary); OR connectors stay OR.
    const rerunIdx = row!.indexOf('re-run the eval');
    const reportIdx = row!.indexOf('report it to the user');
    for (const t of ['passed: false', 'omits the verdict', 'still recurs']) {
      const idx = row!.indexOf(t);
      expect(idx).toBeGreaterThan(-1);
      expect(idx).toBeGreaterThan(rerunIdx);
      expect(idx).toBeLessThan(reportIdx);
    }
    expect(row).toContain('or omits the verdict');
    expect(row).toContain('or contention still recurs');
  });

  it('keeps the critics.md contention entry consistent with the 06 row', () => {
    // critics.md is the category list critic authors follow; its contention entry
    // must carry the same escalate-instead qualifier as the 06 row. Anchor to the
    // category-list entry (not the first mention) and compare case-insensitively
    // (the 06 row capitalizes "Retryable").
    const line = criticsDoc.split('\n').find((l) => l.startsWith('  - `contention`'));
    expect(line).toBeDefined();
    const lower = line!.toLowerCase();
    expect(lower).toContain('add a context steer noting it');
    expect(lower).toContain('retryable from report scope');
    expect(lower).toContain('if a blocking category coexists on a report-only job, escalate instead');
  });

  it('checks the report-only gate before the retry branch', () => {
    // The skill's own comment calls this load-bearing ("This gate runs before the
    // retry branch so a coexisting higher-priority category cannot skip it").
    // Textual ordering is pinnable here. The gate anchor is line-anchored so a
    // comment mentioning the code text cannot satisfy it.
    // Anchor the gate condition semantics too (and any, not and not any / all),
    // whitespace-tolerant across a multi-line reformat, optional parens, and the
    // `if (` style.
    const gateMatch = doc.match(/\n +if \(?\s*source_job\.params\.report_only\s+and\s+\(?\s*any\(/);
    // Line-anchored, order-independent regex that pins enhanced_prompt=prompt as
    // an argument of the SAME retry call: [^)]*? stops at the call's closing
    // paren (best-effort — a nested call's paren can still be crossed), the
    // leading \n + means a comment line (starting with #) cannot satisfy it, and
    // the [,)] boundary means prompt is not matched as a prefix of a longer value.
    const retryMatch = doc.match(
      /\n +tenet_retry_job\(\s*(?:job_id=source_job\.id[^)]*?enhanced_prompt=prompt[,)]|enhanced_prompt=prompt[,)][^)]*?job_id=source_job\.id)/,
    );
    expect(gateMatch).not.toBeNull();
    expect(retryMatch).not.toBeNull();
    const gateIdx = gateMatch ? gateMatch.index ?? -1 : -1;
    const retryIdx = retryMatch ? retryMatch.index ?? -1 : -1;
    expect(gateIdx).toBeLessThan(retryIdx);
  });

  it('names the report-only GATE (not the retry step) as the override', () => {
    // The steer comment regressed twice (rounds 26-27) to "The retry step below
    // is the report-only override" — backwards. Pin the corrected subject AND
    // predicate (the comment spans two lines), anchored to the report-only GATE
    // it describes (the comment must precede the gate).
    const subjectIdx = doc.indexOf('The report-only gate below is the override');
    const predicateIdx = doc.indexOf('it escalates instead of retrying');
    const gateMatch = doc.match(/\n +if source_job\.params\.report_only/);
    expect(subjectIdx).toBeGreaterThan(-1);
    expect(predicateIdx).toBeGreaterThan(-1);
    expect(gateMatch).not.toBeNull();
    const gateIdx = gateMatch ? gateMatch.index ?? -1 : -1;
    expect(subjectIdx).toBeLessThan(gateIdx);
    expect(predicateIdx).toBeLessThan(gateIdx);
  });

  it('names ALL blocking categories in the escalation followup', () => {
    expect(doc).toContain('", ".join(sorted({f.category for f in blocking}))');
  });

  it('labels retry-path details with their category', () => {
    expect(doc).toContain('labeled = "; ".join(f"{f.category}: {f.detail}" for f in findings)');
    // The prompt passed to tenet_retry_job must actually be built from labeled
    // (a regression that drops "+ labeled" from the prompt construction ships an
    // unlabeled prompt with no test failure).
    expect(doc).toMatch(/prompt = "[^"]*" \+ labeled/);
  });
});
