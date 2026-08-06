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
 *
 * Tracks both `{}` and `[]` depth so an object wrapped in a top-level array
 * (`[{"passed": true}]`) is never treated as a verdict — the whole-string fast
 * path rejects arrays, and the scan must agree. `unbalanced` reports whether
 * the stack was left non-empty (a stray `{`/`[` in prose), which is the only
 * condition under which the brace-recovery fallback may run.
 */
const scanTopLevel = (
  text: string,
  accept: (record: Record<string, unknown>) => boolean,
  prefer: (record: Record<string, unknown>) => boolean,
): { best: Record<string, unknown> | null; unbalanced: boolean } => {
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
    if (ch === '{' || ch === '[') {
      stack.push(i);
      continue;
    }
    if ((ch === '}' || ch === ']') && stack.length > 0) {
      const start = stack.pop() as number;
      // Only objects at brace-depth 0 AND bracket-depth 0 count. Nested objects
      // (assertion arrays, tool results quoted in prose) are never verdicts —
      // and neither is an object wrapped in a top-level array.
      if (stack.length !== 0 || ch === ']') {
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
  return { best: bestPreferred ?? bestAny, unbalanced: stack.length > 0 };
};

/**
 * True when the object opened at `open` is "top-level-ish": not inside an
 * array, and not nested inside another VALID JSON object. An object nested
 * under stray prose braces (whose enclosing slice is not valid JSON) IS
 * top-level-ish — that is the verdict the recovery exists to find. This
 * mirrors the strict scan's top-level invariant (scanTopLevel rejects nested
 * and array-wrapped objects) so the recovery cannot pick a nested finding or
 * tool echo over the real verdict.
 */
const isTopLevelish = (text: string, open: number): boolean => {
  const braceStack: number[] = [];
  const bracketStack: number[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < open; i++) {
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
      braceStack.push(i);
    } else if (ch === '}') {
      braceStack.pop();
    } else if (ch === '[') {
      bracketStack.push(i);
    } else if (ch === ']') {
      bracketStack.pop();
    }
  }
  if (inString) {
    // The object's `{` sits inside an unclosed string — a quoted tool result
    // or prior verdict, not a real verdict.
    return false;
  }
  if (bracketStack.length > 0) {
    // Inside an array. Accept only if the INNERMOST enclosing bracket is a
    // stray (its slice is not valid JSON) — i.e. the object is the verdict
    // behind a stray `[` in prose, not genuinely array-wrapped.
    const enclosingOpen = bracketStack[bracketStack.length - 1];
    const enclosingClose = findMatchingClose(text, enclosingOpen);
    if (enclosingClose < 0) {
      return true;
    }
    try {
      JSON.parse(text.slice(enclosingOpen, enclosingClose + 1));
      return false;
    } catch {
      return true;
    }
  }
  if (braceStack.length === 0) {
    return true;
  }
  // Nested under one or more {. Accept only if the INNERMOST enclosing brace
  // is a stray (its slice is not valid JSON) — i.e. the object is the verdict
  // behind prose braces. If the innermost enclosing brace forms a valid
  // object, the object is nested inside it (a finding, a tool echo) and is
  // never the verdict.
  const enclosingOpen = braceStack[braceStack.length - 1];
  const enclosingClose = findMatchingClose(text, enclosingOpen);
  if (enclosingClose < 0) {
    // Enclosing brace never closes — a stray prose brace; the object is the
    // verdict behind it.
    return true;
  }
  try {
    JSON.parse(text.slice(enclosingOpen, enclosingClose + 1));
    // Enclosing brace forms a valid object — the object is nested inside it.
    return false;
  } catch {
    // Enclosing slice is prose braces (e.g. a stray { balanced by a stray })
    // — the object is the verdict behind them.
    return true;
  }
};

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
 * Best-effort recovery for unbalanced braces in prose. The strict top-level
 * scan treats a stray `{` (a code snippet, a truncated block) as an open
 * object, so a verdict that follows it is never top-level and the scan returns
 * null. The critic preamble mandates the verdict at the END of the output, so
 * the verdict is the last JSON object: walk `{` positions from the end, parse
 * each to its MATCHING `}` (not the first `}` — a verdict with nested objects
 * in `findings` would otherwise be sliced unterminated), and apply the same
 * accept/prefer semantics as the strict scan so a passing tool echo after a
 * failing verdict can never win. Only reached when the strict scan found
 * nothing AND the stack was left unbalanced.
 */
const recoverFromUnbalancedBraces = (
  text: string,
  accept: (record: Record<string, unknown>) => boolean,
  prefer: (record: Record<string, unknown>) => boolean,
): Record<string, unknown> | null => {
  let bestPreferred: Record<string, unknown> | null = null;
  let bestAny: Record<string, unknown> | null = null;
  let i = text.lastIndexOf('{');
  while (i >= 0) {
    const end = findMatchingClose(text, i);
    if (end >= 0 && isTopLevelish(text, i)) {
      try {
        const parsed = JSON.parse(text.slice(i, end + 1)) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const record = parsed as Record<string, unknown>;
          if (accept(record)) {
            // The walk goes right-to-left, so the FIRST accepted object per
            // class is the RIGHTMOST — keep it (only set when null), matching
            // the strict scan's rightmost-wins semantics. Overwriting would
            // let a leftmost staged object (e.g. a quoted earlier verdict)
            // beat the real verdict.
            if (prefer(record)) {
              if (!bestPreferred) {
                bestPreferred = record;
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
    // A `{` with no matching close is a stray that cannot be the verdict —
    // skip it and keep walking, or a trailing stray `{` (e.g. a truncated
    // tail) would strand an earlier valid verdict. NOTE: lastIndexOf('{', -1)
    // clamps to 0 and would re-find a `{` at position 0 forever, so break
    // explicitly at i === 0.
    if (i === 0) {
      break;
    }
    i = text.lastIndexOf('{', i - 1);
  }
  return bestPreferred ?? bestAny;
};

/**
 * Merge the strict scan's result with the recovery's when the stack was
 * unbalanced. A staged verdict from either wins — the recovery sees objects
 * the strict scan missed behind a stray brace, so a stage-less echo the strict
 * scan accepted must not short-circuit the recovery's staged verdict. Otherwise
 * prefer the strict scan's top-level result over the recovery's (which may be
 * a nested object).
 */
const mergeStrictAndRecovered = (
  strictBest: Record<string, unknown> | null,
  recovered: Record<string, unknown> | null,
): Record<string, unknown> | null => {
  const recoveredStaged = recovered && typeof recovered.stage === 'string' ? recovered : null;
  const strictStaged = strictBest && typeof strictBest.stage === 'string' ? strictBest : null;
  return recoveredStaged ?? strictStaged ?? strictBest ?? recovered;
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
  const { best, unbalanced } = scanTopLevel(
    text,
    (r) => typeof r.passed === 'boolean',
    (r) => typeof r.stage === 'string',
  );
  if (best && !unbalanced && typeof best.stage === 'string') {
    // A staged top-level verdict with a balanced stack — no recovery needed.
    return best;
  }
  // Otherwise run the recovery: the stack may be unbalanced (a stray brace
  // hides a better verdict), the strict scan may have found nothing (a stray
  // { balanced by a stray } strands the verdict), or best may be a stage-less
  // echo that must not short-circuit the recovery's staged verdict.
  return mergeStrictAndRecovered(
    best,
    recoverFromUnbalancedBraces(text, (r) => typeof r.passed === 'boolean', (r) => typeof r.stage === 'string'),
  );
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
