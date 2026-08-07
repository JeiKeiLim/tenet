/**
 * Shared rubric extraction for critic verdicts.
 *
 * Every critic preamble mandates the verdict shape "End with: {…passed…}" and
 * the built-in critics additionally mandate a `stage` key. This module is the
 * single parser for that shape, shared by the resume gate (job-manager.ts) and
 * the status surface (tenet-get-status.ts) so the two consumers of the same
 * stored critic output can never drift apart.
 *
 * The verdict is the LAST top-level object with a boolean `passed` key. The
 * parser walks `{` positions from the end (the preamble mandates the verdict
 * at the END), parses each to its matching `}`, and keeps the first accepted
 * object per class — preferring one with a `stage` key over a stage-less tool
 * echo. An object nested inside a VALID JSON object or array is never the
 * verdict.
 */

/**
 * Find the index of the `}` that closes the object opened at `open`, tracking
 * nested braces, brackets, and strings. Returns -1 when no matching close
 * exists (a stray `{` in prose).
 */
const findMatchingClose = (text: string, open: number): number => {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i++) {
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
    if (ch === '{' || ch === '[') {
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
};

/**
 * True when the object opened at `open` is top-level: not nested inside a
 * VALID JSON object or array. Prose braces/brackets around it (a stray `{`
 * before the verdict, a truncated container) are fine — that is the recovery
 * case the walk exists to handle. Deliberately does NOT track strings while
 * scanning the prefix: an unmatched quote in prose (e.g. a substring check
 * like `'uv tool install "mkdocs-material'`) must not false-reject a real
 * verdict that follows.
 *
 * KNOWN LIMITATION: an object nested inside a truncated JSON container (a
 * context-limit kill cut it mid-JSON) is accepted as top-level — and a JSON
 * object quoted inside a string is too. Neither shape has been observed in
 * production output (the golden test covers the observed shapes).
 */
const isTopLevelish = (text: string, open: number): boolean => {
  const braceStack: number[] = [];
  const bracketStack: number[] = [];
  for (let i = 0; i < open; i++) {
    const ch = text[i];
    if (ch === '{') {
      braceStack.push(i);
    } else if (ch === '}') {
      braceStack.pop();
    } else if (ch === '[') {
      bracketStack.push(i);
    } else if (ch === ']') {
      bracketStack.pop();
    }
  }
  if (bracketStack.length > 0) {
    // Inside an array. Reject if the INNERMOST enclosing bracket forms a
    // valid array (genuinely array-wrapped).
    const enclosing = bracketStack[bracketStack.length - 1];
    const close = findMatchingClose(text, enclosing);
    if (close >= 0) {
      try {
        JSON.parse(text.slice(enclosing, close + 1));
        return false;
      } catch {
        // Stray/truncated bracket — accept.
      }
    }
  }
  if (braceStack.length > 0) {
    // Nested under one or more {. Reject if the INNERMOST enclosing brace
    // forms a valid object (a finding, a tool echo); accept if it is a stray
    // prose brace (the verdict behind it).
    const enclosing = braceStack[braceStack.length - 1];
    const close = findMatchingClose(text, enclosing);
    if (close >= 0) {
      try {
        JSON.parse(text.slice(enclosing, close + 1));
        return false;
      } catch {
        // Stray/truncated brace — accept.
      }
    }
  }
  return true;
};

/**
 * Rightmost TOP-LEVEL object carrying a boolean `passed` key — the rubric shape
 * every critic preamble mandates. Prefers an object that also carries a
 * `stage` key (the built-in critics' verdict shape): a tool-result echo like
 * `{"passed": true, "tool": "syntax-check"}` rarely carries `stage`, so a
 * staged verdict wins over a later stage-less echo — a failing critic that
 * pastes a passing tool result after its verdict must not false-green the gate.
 */
export const findRightmostPassedObject = (text: string): Record<string, unknown> | null => {
  let bestStaged: Record<string, unknown> | null = null;
  let bestAny: Record<string, unknown> | null = null;
  let i = text.lastIndexOf('{');
  while (i >= 0) {
    const end = findMatchingClose(text, i);
    if (end >= 0 && isTopLevelish(text, i)) {
      try {
        const parsed = JSON.parse(text.slice(i, end + 1)) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const record = parsed as Record<string, unknown>;
          if (typeof record.passed === 'boolean') {
            // The walk goes right-to-left, so the FIRST accepted object per
            // class is the RIGHTMOST — keep it (only set when null).
            if (typeof record.stage === 'string') {
              if (!bestStaged) {
                bestStaged = record;
              }
            } else if (!bestAny) {
              bestAny = record;
            }
          }
        }
      } catch {
        // Not valid JSON — prose braces, skip.
      }
    }
    // NOTE: lastIndexOf('{', -1) clamps to 0 and would re-find a `{` at
    // position 0 forever, so break explicitly at i === 0.
    if (i === 0) {
      break;
    }
    i = text.lastIndexOf('{', i - 1);
  }
  return bestStaged ?? bestAny;
};

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

  // Whole-output fast path: the output is exactly a verdict object.
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
