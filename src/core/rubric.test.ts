import { describe, expect, it } from 'vitest';
import { extractRubricJson } from './rubric.js';

describe('extractRubricJson', () => {
  it('returns a bare verdict object as-is', () => {
    const parsed = extractRubricJson({ passed: true, stage: 'code_critic', findings: [] });
    expect(parsed?.passed).toBe(true);
  });

  it('parses a bare JSON string verdict', () => {
    const parsed = extractRubricJson('{"passed": true, "stage": "code_critic", "findings": []}');
    expect(parsed?.passed).toBe(true);
    expect(parsed?.stage).toBe('code_critic');
  });

  it('parses a fenced verdict block', () => {
    const parsed = extractRubricJson('```json\n{"passed": true, "stage": "code_critic", "findings": []}\n```');
    expect(parsed?.passed).toBe(true);
  });

  it('returns null when no object has a passed key', () => {
    expect(extractRubricJson('I began my review but ran out of context before finishing.')).toBeNull();
  });

  it('ignores a trailing object without a passed key', () => {
    const output = [
      'I reviewed the diff. Verdict:',
      '{"passed": true, "stage": "code_critic", "findings": []}',
      '{"note": "this is a trailing note, not a verdict"}',
    ].join('\n');
    const parsed = extractRubricJson(output);
    expect(parsed?.passed).toBe(true);
    expect(parsed?.stage).toBe('code_critic');
  });

  it('never picks a nested passed object over the top-level verdict', () => {
    // Failing verdict + trailing tool result with nested passed:true — must
    // return the FAILING verdict, not false-green the gate.
    const t1 = [
      'V: {"passed": false, "stage": "code_critic", "findings": [{"category":"product_bug","detail":"x"}]}',
      'Tool output: {"results": [{"name": "syntax", "passed": true}]}',
    ].join('\n');
    const r1 = extractRubricJson(t1);
    expect(r1?.passed).toBe(false);
    expect(r1?.stage).toBe('code_critic');

    // Passing verdict + trailing object with nested passed:false — must
    // return the PASSING verdict, not false-strand the parent.
    const t2 = [
      'V: {"passed": true, "stage": "code_critic", "findings": []}',
      '{"checks": {"lint": {"passed": false}}}',
    ].join('\n');
    const r2 = extractRubricJson(t2);
    expect(r2?.passed).toBe(true);
    expect(r2?.stage).toBe('code_critic');
  });

  it('handles the custom-critic shape (nested assertions in the top-level verdict)', () => {
    const output = JSON.stringify({
      passed: true,
      stage: 'credit_ledger_integrity',
      assertions: [
        { name: 'append_only', passed: true, evidence: 'ledger is append-only' },
        { name: 'audit_fields', passed: true, evidence: 'created_at set' },
      ],
      findings: [],
    });
    const parsed = extractRubricJson(output);
    expect(parsed?.passed).toBe(true);
    expect(parsed?.stage).toBe('credit_ledger_integrity');
  });

  it('does NOT return the first fenced object when a later object is the verdict (fenced-echo regression)', () => {
    // A critic quotes tool output in a fenced block carrying passed:true, then
    // gives a FAILING verdict. The old fenced-first fast path returned the tool
    // object and false-greened the gate.
    const t1 = [
      'The tool reported:',
      '```json',
      '{"tool": "pytest", "passed": true, "count": 12}',
      '```',
      'Verdict: {"passed": false, "stage": "code_critic", "findings": [{"category":"product_bug","detail":"x"}]}',
    ].join('\n');
    const r1 = extractRubricJson(t1);
    expect(r1?.passed).toBe(false);
    expect(r1?.stage).toBe('code_critic');

    // Two fenced blocks, verdict in the second.
    const t2 = [
      '```json',
      '{"tool": "pytest", "passed": true}',
      '```',
      '```json',
      '{"passed": false, "stage": "code_critic", "findings": []}',
      '```',
    ].join('\n');
    const r2 = extractRubricJson(t2);
    expect(r2?.passed).toBe(false);
    expect(r2?.stage).toBe('code_critic');
  });

  it('prefers a staged verdict over a later stage-less echo (echoed-verdict regression)', () => {
    // Failing staged verdict + trailing stage-less tool echo with passed:true.
    const t1 = [
      'V: {"passed": false, "stage": "code_critic", "findings": [{"category":"product_bug","detail":"x"}]}',
      'Tool output: {"passed": true, "tool": "syntax-check"}',
    ].join('\n');
    const r1 = extractRubricJson(t1);
    expect(r1?.passed).toBe(false);
    expect(r1?.stage).toBe('code_critic');

    // Passing staged verdict + trailing stage-less echo with passed:false.
    const t2 = [
      'V: {"passed": true, "stage": "code_critic", "findings": []}',
      'Tool output: {"passed": false, "tool": "syntax-check"}',
    ].join('\n');
    const r2 = extractRubricJson(t2);
    expect(r2?.passed).toBe(true);
    expect(r2?.stage).toBe('code_critic');
  });

  it('recovers a verdict after an unbalanced { in prose (unbalanced-brace regression)', () => {
    // A stray { in prose before the verdict used to leave a permanent stack
    // entry, so the verdict was never top-level and the parent stranded.
    const t1 = 'The signature is foo({ and then the verdict: {"passed": true, "stage": "code_critic", "findings": []}';
    const r1 = extractRubricJson(t1);
    expect(r1?.passed).toBe(true);
    expect(r1?.stage).toBe('code_critic');

    // Truncated code block before the verdict.
    const t2 = 'I checked the diff:\n```ts\nfunction foo() {\n  return 1;\n```\nVerdict: {"passed": false, "stage": "code_critic", "findings": ["x"]}';
    const r2 = extractRubricJson(t2);
    expect(r2?.passed).toBe(false);
    expect(r2?.stage).toBe('code_critic');
  });

  it('keeps the top-level invariant for a stage-less verdict followed by a nested passed object', () => {
    const output = [
      'V: {"passed": true}',
      '{"checks": {"lint": {"passed": false}}}',
    ].join('\n');
    const parsed = extractRubricJson(output);
    expect(parsed?.passed).toBe(true);
  });

  it('rejects an object wrapped in a top-level array (bracket-depth regression)', () => {
    // The scanner tracks {} but must also track [] — an array of verdicts is
    // not a verdict object, and the whole-string fast path already rejects it.
    const t1 = '[{"passed": true, "stage": "code_critic"}]';
    expect(extractRubricJson(t1)).toBeNull();

    // A verdict followed by an array of passed objects must keep the verdict.
    const t2 = [
      'V: {"passed": false, "stage": "code_critic", "findings": ["x"]}',
      '[{"passed": true, "tool": "syntax-check"}]',
    ].join('\n');
    const r2 = extractRubricJson(t2);
    expect(r2?.passed).toBe(false);
    expect(r2?.stage).toBe('code_critic');
  });

  it('does not run the brace recovery on balanced output with no top-level verdict', () => {
    // The recovery exists for unbalanced braces in prose. On balanced output
    // whose only passed object is nested, it must NOT fire and pick up the
    // nested object — that would false-strand (or false-green) the gate.
    const t1 = '{"checks": {"lint": {"passed": false}}}';
    expect(extractRubricJson(t1)).toBeNull();

    const t2 = '{"results": [{"name": "syntax", "passed": true}]}';
    expect(extractRubricJson(t2)).toBeNull();
  });

  it('recovery: a passing tool echo after a failing verdict never wins (stray-brace + echo)', () => {
    // A stray { in prose makes the strict scan fail; the recovery must still
    // prefer the staged failing verdict over the stage-less passing echo.
    const t1 = [
      'The signature is foo({ and then the verdict:',
      '{"passed": false, "stage": "code_critic", "findings": ["x"]}',
      'and the tool said {"results": [{"name": "syntax", "passed": true}]}',
    ].join('\n');
    const r1 = extractRubricJson(t1);
    expect(r1?.passed).toBe(false);
    expect(r1?.stage).toBe('code_critic');

    const t2 = [
      'prose { then verdict {"passed": false, "stage": "code_critic", "findings": []}',
      'then tool {"passed": true, "tool": "syntax-check"}',
    ].join('\n');
    const r2 = extractRubricJson(t2);
    expect(r2?.passed).toBe(false);
    expect(r2?.stage).toBe('code_critic');
  });

  it('recovery: a verdict with nested objects in findings still parses (matching-close)', () => {
    // The recovery must slice to the verdict's MATCHING } — the first } after
    // the { would slice an unterminated findings array and strand the parent.
    const t1 = 'The signature is foo({ and then the verdict: {"passed": false, "stage": "code_critic", "findings": [{"category":"product_bug","detail":"x"}]}';
    const r1 = extractRubricJson(t1);
    expect(r1?.passed).toBe(false);
    expect(r1?.stage).toBe('code_critic');

    // A finding object carrying its own passed key must never be picked over
    // the staged verdict.
    const t2 = 'Note: { and then {"passed": false, "stage": "code_critic", "findings": [{"category":"product_bug","detail":"x","passed": true}]}';
    const r2 = extractRubricJson(t2);
    expect(r2?.passed).toBe(false);
    expect(r2?.stage).toBe('code_critic');
  });

  it('recovery: a passing echo BEFORE a stray { cannot mask a failing verdict (merge regression)', () => {
    // The strict scan accepts the stage-less echo as bestAny; the stray {
    // hides the staged failing verdict. The recovery must still run and its
    // staged verdict must win over the echo.
    const t1 = [
      'Tool output: {"passed": true, "tool": "pytest", "count": 12}',
      'The signature is foo({ and then the verdict: {"passed": false, "stage": "code_critic", "findings": ["x"]}',
    ].join('\n');
    const r1 = extractRubricJson(t1);
    expect(r1?.passed).toBe(false);
    expect(r1?.stage).toBe('code_critic');

    const t2 = '{"passed": true} some prose {unterminated {"passed": false, "stage": "code_critic"}';
    const r2 = extractRubricJson(t2);
    expect(r2?.passed).toBe(false);
    expect(r2?.stage).toBe('code_critic');
  });

  it('recovery: a trailing stray { after the verdict does not strand it (continue regression)', () => {
    // The recovery walks { from the end; a trailing { with no matching close
    // must be skipped, not break the walk before reaching the verdict.
    const t1 = 'The signature is foo({ and then the verdict: {"passed": true, "stage": "code_critic", "findings": []} and then more prose {';
    const r1 = extractRubricJson(t1);
    expect(r1?.passed).toBe(true);
    expect(r1?.stage).toBe('code_critic');

    const t2 = 'stray { {"passed": true, "stage": "code_critic", "findings": []} more { no close';
    const r2 = extractRubricJson(t2);
    expect(r2?.passed).toBe(true);
    expect(r2?.stage).toBe('code_critic');
  });

  it('recovery: two staged objects with a stray brace keep the RIGHTMOST verdict (rightmost-wins regression)', () => {
    // The recovery walks { right-to-left but must keep the first accepted
    // object per class (the rightmost), not overwrite with the leftmost.
    const t1 = [
      '{"passed": true, "stage": "code_critic", "findings": []}',
      'The signature is foo({ and then the verdict:',
      '{"passed": false, "stage": "code_critic", "findings": ["x"]}',
    ].join('\n');
    const r1 = extractRubricJson(t1);
    expect(r1?.passed).toBe(false);
    expect(r1?.stage).toBe('code_critic');

    // Mirrored: failing verdict before the stray brace, passing verdict after.
    const t2 = [
      '{"passed": false, "stage": "code_critic", "findings": ["x"]}',
      'The signature is foo({ and then the verdict:',
      '{"passed": true, "stage": "code_critic", "findings": []}',
    ].join('\n');
    const r2 = extractRubricJson(t2);
    expect(r2?.passed).toBe(true);
    expect(r2?.stage).toBe('code_critic');
  });

  it('recovery: escaped quotes and unterminated strings in the verdict still parse (string-state)', () => {
    // findMatchingClose must treat \" inside a string as escaped, not a string
    // terminator — a regression would close the string early and strand the
    // verdict.
    const t1 = 'The signature is foo({ and then the verdict: {"passed": false, "stage": "code_critic", "findings": [{"category":"product_bug","detail":"the fix broke \\"login\\""}]}';
    const r1 = extractRubricJson(t1);
    expect(r1?.passed).toBe(false);
    expect(r1?.stage).toBe('code_critic');

    // A trailing unterminated string after a green verdict must be skipped.
    const t2 = 'stray { {"passed": true, "stage": "code_critic", "findings": []} then {"note": "unterminated';
    const r2 = extractRubricJson(t2);
    expect(r2?.passed).toBe(true);
    expect(r2?.stage).toBe('code_critic');
  });

  it('recovery: a nested passed+stage object inside the verdict never wins (top-level guard)', () => {
    // The recovery must reject objects nested inside a valid JSON object, even
    // when they echo the verdict shape (passed + stage).
    const t1 = 'stray { {"passed": false, "detail": {"passed": true, "stage": "code_critic"}}';
    const r1 = extractRubricJson(t1);
    expect(r1?.passed).toBe(false);

    const t2 = 'stray { {"passed": false, "stage": "code_critic", "findings": [{"category":"x","detail":"y","passed": true, "stage": "code_critic"}]}';
    const r2 = extractRubricJson(t2);
    expect(r2?.passed).toBe(false);
    expect(r2?.stage).toBe('code_critic');
  });

  it('recovery: an array-wrapped staged echo never wins (bracket-depth guard)', () => {
    const t1 = 'stray { {"passed": false, "stage": "code_critic", "findings": ["x"]} [{"passed": true, "stage": "code_critic"}]';
    const r1 = extractRubricJson(t1);
    expect(r1?.passed).toBe(false);
    expect(r1?.stage).toBe('code_critic');
  });

  it('recovery: a stage-less verdict followed by a nested passed:true echo keeps the verdict', () => {
    const t1 = [
      'I checked the signature foo({ and the verdict:',
      '{"passed": false}',
      'Tool output: {"checks": {"lint": {"passed": true}}}',
    ].join('\n');
    const r1 = extractRubricJson(t1);
    expect(r1?.passed).toBe(false);
  });

  it('recovery: a stray { balanced by a stray } after the verdict does not strand it', () => {
    // The stack ends balanced (unbalanced=false) but the verdict is hidden
    // behind the stray pair — the recovery must still run and find it.
    const t1 = 'The signature is foo({ and the verdict: {"passed": true, "stage": "code_critic", "findings": []} and the closing brace }';
    const r1 = extractRubricJson(t1);
    expect(r1?.passed).toBe(true);
    expect(r1?.stage).toBe('code_critic');
  });

  it('recovery: a verdict behind TWO+ stray braces still wins over a passing echo', () => {
    // isTopLevelish must accept the verdict behind any number of stray prose
    // braces (e.g. a truncated `if (x) { if (y) {` snippet), not just one.
    const t1 = [
      'Tool output: {"passed": true, "tool": "pytest", "count": 12}',
      'The code: if (x) { if (y) { and then the verdict:',
      '{"passed": false, "stage": "code_critic", "findings": ["x"]}',
    ].join('\n');
    const r1 = extractRubricJson(t1);
    expect(r1?.passed).toBe(false);
    expect(r1?.stage).toBe('code_critic');

    // No echo: the verdict behind two stray braces must still be found.
    const t2 = 'The code: if (x) { if (y) { and then the verdict: {"passed": true, "stage": "code_critic", "findings": []}';
    const r2 = extractRubricJson(t2);
    expect(r2?.passed).toBe(true);
    expect(r2?.stage).toBe('code_critic');
  });

  it('recovery: a stray [ in prose does not strand the verdict (bracket-stray)', () => {
    // isTopLevelish must distinguish a stray [ in prose from a genuine array.
    const t1 = 'The list was [1, 2, 3 and then the verdict: {"passed": true, "stage": "code_critic", "findings": []}';
    const r1 = extractRubricJson(t1);
    expect(r1?.passed).toBe(true);
    expect(r1?.stage).toBe('code_critic');

    // A balanced array before the verdict is fine too.
    const t2 = '[1, 2, 3] and then the verdict: {"passed": true, "stage": "code_critic", "findings": []}';
    const r2 = extractRubricJson(t2);
    expect(r2?.passed).toBe(true);
  });

  it('recovery: a stage-less echo before a stray brace cannot mask a stage-less verdict (merge order)', () => {
    // When neither object is staged, the recovery's rightmost result must win
    // over the strict scan's echo (the "verdict at the END" preamble).
    const t1 = 'Tool output: {"passed": true, "tool": "syntax-check"} and then a stray { and then the verdict: {"passed": false}';
    const r1 = extractRubricJson(t1);
    expect(r1?.passed).toBe(false);

    const t2 = 'Tool output: {"passed": false, "tool": "syntax-check"} and then a stray { and then the verdict: {"passed": true}';
    const r2 = extractRubricJson(t2);
    expect(r2?.passed).toBe(true);
  });

  it('recovery: a stage-less echo + balanced stray pair cannot mask a failing verdict', () => {
    // The strict scan accepts the echo (bestAny) and the stray pair balances
    // (unbalanced=false), so the recovery must still run — a stage-less best
    // must not short-circuit the recovery's staged verdict.
    const t1 = [
      'Tool output: {"passed": true, "tool": "pytest", "count": 12}',
      'and prose { and the verdict: {"passed": false, "stage": "code_critic", "findings": ["x"]} }',
    ].join('\n');
    const r1 = extractRubricJson(t1);
    expect(r1?.passed).toBe(false);
    expect(r1?.stage).toBe('code_critic');
  });

  it('KNOWN LIMITATION: a staged echo (quoted prior verdict) after a failing verdict wins', () => {
    // The parser cannot distinguish a real verdict from a quoted earlier
    // verdict by shape — both carry passed + stage. The preamble mandates the
    // verdict at the END, so a critic that quotes a same-stage verdict after
    // its own violates the preamble and the rightmost staged object wins.
    // This is a documented limitation, not a regression to fix silently.
    const t1 = [
      'Final: {"passed": false, "stage": "code_critic", "findings": ["x"]}',
      '(quoted from round 1: {"passed": true, "stage": "code_critic"})',
    ].join('\n');
    const r1 = extractRubricJson(t1);
    expect(r1?.passed).toBe(true);
  });
});

describe('tenet_get_status surface (extractRubricJson — the production parser)', () => {
  it('extracts layer2_status from e2e output with prose braces after the verdict', () => {
    const output = [
      'I explored the UI and ran the scripted checks.',
      '{"passed": true, "stage": "interaction_e2e", "layer2_status": "completed", "scripted_results": "all green"}',
      'Note: the fix touched { src/foo.ts } and { src/bar.ts }.',
    ].join('\n');
    const parsed = extractRubricJson(output);
    expect(parsed?.layer2_status).toBe('completed');
  });

  it('recovers layer2_status after an unbalanced { in prose', () => {
    const output = 'Note: { src/foo.ts and then {"passed": true, "stage": "interaction_e2e", "layer2_status": "completed"}';
    const parsed = extractRubricJson(output);
    expect(parsed?.layer2_status).toBe('completed');
  });

  it('a valid-JSON tool echo after the verdict does not override layer2_status (stage-preference)', () => {
    // The old accept-any scan returned the echo object, falsifying or dropping
    // layer2_status. The e2e verdict carries stage; the echo does not.
    const t1 = [
      '{"passed": true, "stage": "interaction_e2e", "layer2_status": "completed"}',
      'Tool: {"layer2_status": "failed", "tool": "syntax-check"}',
    ].join('\n');
    const r1 = extractRubricJson(t1);
    expect(r1?.layer2_status).toBe('completed');

    const t2 = [
      '```json',
      '{"passed": true, "stage": "interaction_e2e", "layer2_status": "completed"}',
      '```',
      'Then I checked: {"note": "all good"}',
    ].join('\n');
    const r2 = extractRubricJson(t2);
    expect(r2?.layer2_status).toBe('completed');
  });

  it('a verdict without a passed key drops layer2_status (fail-closed, matches the gate)', () => {
    // tenet_get_status uses extractRubricJson, which requires `passed` — the
    // same requirement as the resume gate. A malformed verdict without passed
    // drops layer2_status rather than surfacing a value the gate would reject.
    const output = '{"layer2_status": "completed", "stage": "interaction_e2e"}';
    expect(extractRubricJson(output)).toBeNull();
  });
});
