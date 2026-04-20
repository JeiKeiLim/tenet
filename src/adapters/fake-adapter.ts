import fs from 'node:fs';
import path from 'node:path';
import type { AgentAdapter, AgentInvocation, AgentResponse } from './base.js';

export type FixturePredicate = (invocation: AgentInvocation) => boolean;

export type FakeFixtureRule = {
  /**
   * Match this fixture against an invocation. Returned true → the fixture is served.
   * Rules are evaluated in declaration order; first match wins.
   */
  match: FixturePredicate;
  /**
   * Path to the fixture file (relative paths are resolved against `fixturesRoot`).
   */
  fixture: string;
  /**
   * Override the response success flag. Defaults to true.
   * Set false to simulate an adapter invocation that failed outright (not just
   * a critic that returned passed:false — that's the fixture *content*'s job).
   */
  success?: boolean;
  /**
   * Optional error message attached to a failed response.
   */
  error?: string;
  /**
   * If set, the fixture is served at most this many times. Further matching
   * invocations fall through to later rules. Useful when a scenario needs
   * different outputs for the same job type on different calls.
   */
  maxUses?: number;
};

export type FakeAdapterOptions = {
  /**
   * Display name for the adapter. Defaults to 'fake'.
   */
  name?: string;
  /**
   * Directory that relative fixture paths are resolved against.
   * Defaults to `tests/fixtures/fake-agents` at the repo root.
   */
  fixturesRoot?: string;
  /**
   * Invocations that don't match any rule throw by default (loud failure is
   * the whole point of this adapter). Flip to 'return-empty' if a scenario
   * deliberately wants the default fallback path.
   */
  onMiss?: 'throw' | 'return-empty';
  /**
   * Hook called for every invocation before matching. Lets scenarios observe
   * what the orchestrator dispatched without touching adapter internals.
   */
  onInvoke?: (invocation: AgentInvocation) => void;
};

/**
 * Deterministic test adapter that serves scripted responses from fixture files.
 *
 * Usage: construct with an ordered list of rules. Each rule has a predicate
 * over the invocation (prompt contents, etc.) and points to a fixture file
 * whose raw bytes are returned as `AgentResponse.output`.
 *
 * The whole point: real agent output is messy (JSON inside prose, fenced
 * blocks, truncated streams). Fixtures store exact bytes so integration tests
 * exercise the real parsers — no pre-parsed detour.
 */
export class FakeAdapter implements AgentAdapter {
  public readonly name: string;
  private readonly rules: FakeFixtureRule[];
  private readonly uses: Map<FakeFixtureRule, number>;
  private readonly fixturesRoot: string;
  private readonly onMiss: 'throw' | 'return-empty';
  private readonly onInvoke?: (invocation: AgentInvocation) => void;

  constructor(rules: FakeFixtureRule[], options: FakeAdapterOptions = {}) {
    this.name = options.name ?? 'fake';
    this.rules = rules;
    this.uses = new Map();
    this.fixturesRoot = options.fixturesRoot ?? defaultFixturesRoot();
    this.onMiss = options.onMiss ?? 'throw';
    this.onInvoke = options.onInvoke;
  }

  async invoke(invocation: AgentInvocation): Promise<AgentResponse> {
    this.onInvoke?.(invocation);

    for (const rule of this.rules) {
      if (rule.maxUses !== undefined) {
        const used = this.uses.get(rule) ?? 0;
        if (used >= rule.maxUses) {
          continue;
        }
      }
      if (!rule.match(invocation)) {
        continue;
      }

      this.uses.set(rule, (this.uses.get(rule) ?? 0) + 1);

      const fixturePath = path.isAbsolute(rule.fixture)
        ? rule.fixture
        : path.join(this.fixturesRoot, rule.fixture);

      if (!fs.existsSync(fixturePath)) {
        throw new Error(`FakeAdapter fixture not found: ${fixturePath}`);
      }

      const output = fs.readFileSync(fixturePath, 'utf8');
      return {
        success: rule.success ?? true,
        output,
        error: rule.error,
        durationMs: 0,
      };
    }

    if (this.onMiss === 'return-empty') {
      return { success: true, output: '', durationMs: 0 };
    }

    const summary = summarizeInvocation(invocation);
    throw new Error(
      `FakeAdapter: no fixture rule matched invocation.\n${summary}\n` +
        `Add a matching rule to the adapter's rules list, or set onMiss: 'return-empty'.`,
    );
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

/**
 * Common predicate builders — keep scenario setup terse without losing clarity.
 */
export const matchers = {
  /** Match any invocation. Useful as a final fallback rule. */
  any: (): FixturePredicate => () => true,

  /** Match when the prompt contains the given substring (case-sensitive). */
  promptContains:
    (needle: string): FixturePredicate =>
    (inv) =>
      inv.prompt.includes(needle),

  /** Match when the prompt mentions the given eval stage. */
  evalStage:
    (stage: 'code_critic' | 'test_critic' | 'playwright_eval' | 'readiness_validation'): FixturePredicate =>
    (inv) => {
      // eval_stage isn't on AgentInvocation directly — it's embedded in the prompt
      // via tenet_start_eval's preambles ("## Code Critic ...") / validate-readiness rubric.
      const markers: Record<string, string[]> = {
        code_critic: ['Code Critic', '"stage": "code_critic"'],
        test_critic: ['Test Critic', '"stage": "test_critic"'],
        playwright_eval: ['Playwright', 'PLAYWRIGHT EVAL'],
        readiness_validation: ['IMPLEMENTATION READINESS', 'readiness'],
      };
      return markers[stage].some((m) => inv.prompt.includes(m));
    },

  /** Match when the prompt looks like a dev job (Deliverable Requirements preamble). */
  devJob: (): FixturePredicate => (inv) => inv.prompt.includes('Deliverable Requirements'),
};

const defaultFixturesRoot = (): string => {
  // Resolve relative to this file so tests can discover fixtures regardless of CWD.
  // src/adapters/fake-adapter.ts → <repo>/src/adapters → <repo>
  const here = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(here, '..', '..', 'tests', 'fixtures', 'fake-agents');
};

const summarizeInvocation = (inv: AgentInvocation): string => {
  const preview = inv.prompt.slice(0, 200).replace(/\s+/g, ' ');
  const truncated = inv.prompt.length > 200 ? ` ... (+${inv.prompt.length - 200} chars)` : '';
  return `  prompt: ${preview}${truncated}\n  workdir: ${inv.workdir ?? '(none)'}`;
};
