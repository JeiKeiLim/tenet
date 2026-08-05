import { describe, expect, it } from 'vitest';
import { extractRubricJson, findRightmostTopLevelObject } from './rubric.js';

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
});

describe('findRightmostTopLevelObject (tenet_get_status surface)', () => {
  it('extracts layer2_status from e2e output with prose braces after the verdict', () => {
    const output = [
      'I explored the UI and ran the scripted checks.',
      '{"passed": true, "stage": "interaction_e2e", "layer2_status": "completed", "scripted_results": "all green"}',
      'Note: the fix touched { src/foo.ts } and { src/bar.ts }.',
    ].join('\n');
    const parsed = findRightmostTopLevelObject(output);
    expect(parsed?.layer2_status).toBe('completed');
  });

  it('recovers layer2_status after an unbalanced { in prose', () => {
    const output = 'Note: { src/foo.ts and then {"passed": true, "stage": "interaction_e2e", "layer2_status": "completed"}';
    const parsed = findRightmostTopLevelObject(output);
    expect(parsed?.layer2_status).toBe('completed');
  });
});
