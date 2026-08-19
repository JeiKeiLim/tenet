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

  it('fires the contention steer as a context NOTE inside the guard, before the report-only gate', () => {
    // The steer must be guarded on contention (and INSIDE the guard block, not
    // dedented out of it), be class="context" (a note, not a command — no MCP tool
    // can set eval_parallel_safe), and precede the report_only gate so a
    // higher-priority category cannot skip it on either path.
    const guardMatch = doc.match(/\n +if any\(f\.category == "contention"/);
    const steerIdx = doc.indexOf('tenet_add_steer(content=f"contention detected in eval');
    const gateIdx = doc.indexOf('if source_job.params.report_only');
    expect(guardMatch).not.toBeNull();
    expect(steerIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(-1);
    const guardIdx = guardMatch ? guardMatch.index ?? -1 : -1;
    expect(guardIdx).toBeLessThan(steerIdx);
    expect(steerIdx).toBeLessThan(gateIdx);
    // The steer must be indented deeper than the guard (inside its block).
    // guardIdx points at the '\n' before the guard line, so the guard line runs
    // from guardIdx+1 to the next '\n'.
    const guardLine = doc.slice(guardIdx + 1, doc.indexOf('\n', guardIdx + 1));
    const steerLine = doc.slice(doc.lastIndexOf('\n', steerIdx) + 1, doc.indexOf('\n', steerIdx));
    const guardIndent = guardLine.match(/^ */)?.[0].length ?? 0;
    const steerIndent = steerLine.match(/^ */)?.[0].length ?? 0;
    expect(steerIndent).toBeGreaterThan(guardIndent);
    // The steer call must carry class="context" — anchored to the steer call's
    // own line (non-vacuous) without pinning the message text or argument order.
    expect(steerLine).toContain('class="context"');
  });

  it('checks the report-only gate before the retry branch', () => {
    // The skill's own comment calls this load-bearing ("This gate runs before the
    // retry branch so a coexisting higher-priority category cannot skip it").
    // Textual ordering is pinnable here.
    const gateIdx = doc.indexOf('if source_job.params.report_only');
    const retryIdx = doc.indexOf('tenet_retry_job(job_id=source_job.id, enhanced_prompt=prompt)');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(retryIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(retryIdx);
  });

  it('names ALL blocking categories in the escalation followup', () => {
    expect(doc).toContain('", ".join(sorted({f.category for f in blocking}))');
  });

  it('labels retry-path details with their category', () => {
    expect(doc).toContain('labeled = "; ".join(f"{f.category}: {f.detail}" for f in findings)');
  });
});
