/**
 * Shared rubric extraction for critic verdicts.
 *
 * Every critic preamble mandates the verdict shape "End with: {…passed…}" and
 * the built-in critics additionally mandate a `stage` key. This module is the
 * single parser for that shape, shared by the resume gate (job-manager.ts) and
 * the status surface (tenet-get-status.ts) so the two consumers of the same
 * stored critic output can never drift apart.
 */

/**
 * Scan a string for top-level JSON objects, returning the rightmost one that
 * `accept` approves. When `prefer` approves an object, it wins over any
 * non-preferred object even if the non-preferred one appears later — used to
 * prefer verdicts that carry a `stage` key over stage-less tool-result echoes.
 */
const scanTopLevel = (
  text: string,
  accept: (record: Record<string, unknown>) => boolean,
  prefer: (record: Record<string, unknown>) => boolean,
): Record<string, unknown> | null => {
  const stack: number[] = [];
  let inString = false;
  let escaped = false;
  let bestPreferred: Record<string, unknown> | null = null;
  let bestAny: Record<string, unknown> | null = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      stack.push(i);
      continue;
    }
    if (ch === '}' && stack.length > 0) {
      const start = stack.pop() as number;
      // Only top-level objects count. Nested objects (assertion arrays, tool
      // results quoted in prose) are never verdicts.
      if (stack.length !== 0) {
        continue;
      }
      try {
        const parsed = JSON.parse(text.slice(start, i + 1)) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const record = parsed as Record<string, unknown>;
          if (accept(record)) {
            if (prefer(record)) {
              bestPreferred = record;
            } else {
              bestAny = record;
            }
          }
        }
      } catch {
        // Not valid JSON — prose braces, skip.
      }
    }
  }
  return bestPreferred ?? bestAny;
};

/**
 * Best-effort recovery for unbalanced braces in prose. The strict top-level
 * scan treats a stray `{` (a code snippet, a truncated block) as an open
 * object, so a verdict that follows it is never top-level and the scan returns
 * null. The critic preamble mandates the verdict at the END of the output, so
 * the verdict is the last JSON object: walk `{` positions from the end, parse
 * each to the first `}` after it, and return the first object `accept`
 * approves. Only reached when the strict scan found nothing.
 */
const recoverFromUnbalancedBraces = (
  text: string,
  accept: (record: Record<string, unknown>) => boolean,
): Record<string, unknown> | null => {
  for (let i = text.lastIndexOf('{'); i >= 0; i = text.lastIndexOf('{', i - 1)) {
    const end = text.indexOf('}', i);
    if (end < 0) {
      break;
    }
    try {
      const parsed = JSON.parse(text.slice(i, end + 1)) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (accept(record)) {
          return record;
        }
      }
    } catch {
      // Not valid JSON — prose braces, skip.
    }
  }
  return null;
};

/**
 * Rightmost TOP-LEVEL JSON object in a string, regardless of keys. Used by
 * tenet_get_status to surface layer2_status from e2e critic output.
 */
export const findRightmostTopLevelObject = (text: string): Record<string, unknown> | null =>
  scanTopLevel(text, () => true, () => false) ?? recoverFromUnbalancedBraces(text, () => true);

/**
 * Rightmost TOP-LEVEL object carrying a boolean `passed` key — the rubric shape
 * every critic preamble mandates. Prefers an object that also carries a
 * `stage` key (the built-in critics' verdict shape): a tool-result echo like
 * `{"passed": true, "tool": "syntax-check"}` rarely carries `stage`, so a
 * staged verdict wins over a later stage-less echo — a failing critic that
 * pastes a passing tool result after its verdict must not false-green the gate.
 */
export const findRightmostPassedObject = (text: string): Record<string, unknown> | null =>
  scanTopLevel(
    text,
    (r) => typeof r.passed === 'boolean',
    (r) => typeof r.stage === 'string',
  ) ?? recoverFromUnbalancedBraces(text, (r) => typeof r.passed === 'boolean');

/**
 * Extract the critic verdict from a worker's raw output. Accepts a bare object
 * (already-parsed output), a bare JSON string, or prose containing the verdict
 * JSON. Returns null when no passed-bearing object is found.
 */
export const extractRubricJson = (rawOutput: unknown): Record<string, unknown> | null => {
  if (rawOutput && typeof rawOutput === 'object') {
    return rawOutput as Record<string, unknown>;
  }

  if (typeof rawOutput !== 'string') {
    return null;
  }

  const stripped = rawOutput.trim();

  // Whole-output fast path: the output is exactly a verdict object. No
  // fenced-first shortcut — a fenced block earlier in the output is never the
  // verdict over a later one, so the scan below is the single source of truth.
  try {
    const parsed = JSON.parse(stripped) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).passed === 'boolean'
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not a bare JSON object — scan below.
  }

  return findRightmostPassedObject(stripped);
};
