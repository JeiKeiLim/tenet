import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The finding-category dispatch in 05-execution-loop.md is agent-executed decision
// logic (the orchestrator reads the skill, not Tenet code), so it cannot be unit
// tested the way tool handlers are. These assertions pin the structural invariants
// that have regressed repeatedly across review rounds — a future edit that drops
// the escalation gate, moves the contention steer back into a single branch, or
// reintroduces a single-category followup override will fail here.

const here = path.dirname(fileURLToPath(import.meta.url));
const skillPath = path.resolve(here, '..', '..', 'skills', 'tenet', 'phases', '05-execution-loop.md');
const doc = fs.readFileSync(skillPath, 'utf8');

describe('skill finding-category dispatch contract', () => {
  it('escalates ANY non-retryable category for report-only jobs (gate matches filter)', () => {
    expect(doc).toContain('f.category not in ("evidence_mismatch", "contention")');
  });

  it('fires the contention steer unconditionally, before the report-only/retry split', () => {
    const steerIdx = doc.indexOf('tenet_add_steer(content=f"set eval_parallel_safe=false');
    const gateIdx = doc.indexOf('if source_job.params.report_only');
    expect(steerIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(-1);
    // The steer must precede the report_only gate so a higher-priority category
    // cannot skip it on either the escalation or the retry path.
    expect(steerIdx).toBeLessThan(gateIdx);
  });

  it('names ALL blocking categories in the escalation followup (no single-category override)', () => {
    expect(doc).toContain('", ".join(sorted({f.category for f in blocking}))');
  });

  it('labels retry-path details with their category', () => {
    expect(doc).toContain('labeled = "; ".join(f"{f.category}: {f.detail}" for f in findings)');
  });
});
