import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The finding-category dispatch in 05-execution-loop.md is agent-executed decision
// logic (the orchestrator reads the skill, not Tenet code), so it cannot be unit
// tested the way tool handlers are. These assertions pin the structural invariants
// that have regressed repeatedly across review rounds — a future edit that narrows
// the escalation gate, moves the contention steer back into a single branch,
// replaces the multi-category followup with a single-category override, or drops
// the category labels will fail here.

const here = path.dirname(fileURLToPath(import.meta.url));
const skillPath = path.resolve(here, '..', '..', 'skills', 'tenet', 'phases', '05-execution-loop.md');
const doc = fs.readFileSync(skillPath, 'utf8');

describe('skill finding-category dispatch contract', () => {
  it('uses the SAME exclusion set in the report-only gate and the blocking filter', () => {
    // Extract every `f.category not in (...)` set; the gate and the filter must
    // agree, or a report-only job with an unknown category falls to a doomed retry.
    const sets = [...doc.matchAll(/f\.category not in \(([^)]*)\)/g)].map((m) => m[1].trim());
    expect(sets.length).toBeGreaterThanOrEqual(2);
    for (const s of sets) {
      expect(s).toBe('"evidence_mismatch", "contention"');
    }
  });

  it('fires the contention steer unconditionally, before the report-only gate', () => {
    const steerIdx = doc.indexOf('tenet_add_steer(content=f"set eval_parallel_safe=false');
    const gateIdx = doc.indexOf('if source_job.params.report_only');
    expect(steerIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(-1);
    // The steer must precede the report_only gate so a higher-priority category
    // cannot skip it on either the escalation or the retry path.
    expect(steerIdx).toBeLessThan(gateIdx);
  });

  it('checks the report-only gate before the retry branch', () => {
    const gateIdx = doc.indexOf('if source_job.params.report_only');
    const retryIdx = doc.indexOf('tenet_retry_job(job_id=source_job.id, enhanced_prompt=prompt)');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(retryIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(retryIdx);
  });

  it('names ALL blocking categories in the escalation followup', () => {
    expect(doc).toContain('", ".join(sorted({f.category for f in blocking}))');
  });

  it('keeps any scope_conflict hint as an APPEND, never a single-category replacement', () => {
    // The round-10 regression replaced the multi-category followup with a
    // scope_conflict-only directive. The current design appends a hint.
    if (doc.includes('For scope_conflict:')) {
      expect(doc).toContain('followup += " For scope_conflict:');
    }
  });

  it('labels retry-path details with their category', () => {
    expect(doc).toContain('labeled = "; ".join(f"{f.category}: {f.detail}" for f in findings)');
  });

  it('consolidates ALL findings into a single retry call', () => {
    expect(doc).toContain('Consolidate ALL findings into ONE retry call');
  });
});
