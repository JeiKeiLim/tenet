import fs from 'node:fs';
import path from 'node:path';

export const UNLIMITED_RETRIES = -1;
export const DEFAULT_MAX_RETRIES = UNLIMITED_RETRIES;
export const DEFAULT_JOB_TIMEOUT_MINUTES = 120;
export const DEFAULT_JOB_TIMEOUT_MS = DEFAULT_JOB_TIMEOUT_MINUTES * 60 * 1000;

/** Resolved adviser settings — present only when both config keys are set. */
export type AdviserConfig = {
  agent: string;
  model: string;
};

/**
 * Resolved per-gate validator pairs (interview clarity / implementation
 * readiness). Each pair is present only when BOTH of the gate's config keys
 * are set — a partially configured gate behaves exactly like an unset one.
 */
export type GateValidatorsConfig = {
  clarity?: { agent: string; model: string };
  readiness?: { agent: string; model: string };
};

export type AgentModelConfig = {
  adviser?: AdviserConfig;
  defaultAgentModel?: string;
  gateValidators?: GateValidatorsConfig;
};

/** The two interview-time validation gates, keyed by their config pair. */
export type GateKey = 'clarity' | 'readiness';

/** The sibling gate in the validator fallback chain (symmetric, never loops). */
const siblingGate = (gate: GateKey): GateKey => (gate === 'clarity' ? 'readiness' : 'clarity');

/**
 * The validator-gate fallback chain: the gate's own pair, then the sibling
 * gate's pair, then the adviser pair. Single source of truth — JobManager
 * (dispatch) and the CLI config display/warnings both resolve through here.
 *
 * Every tier is a COMPLETE agent+model pair, never a bare model on a different
 * agent: model strings are per-CLI (claude aliases / codex catalog / opencode
 * provider:model), so a model is only meaningful paired with its own agent.
 * Returns undefined when no tier resolves — the gate then takes today's eval
 * path (agent_override_eval ?? default_agent) untouched.
 */
export const resolveGatePair = (
  gateValidators: GateValidatorsConfig | undefined,
  adviser: AdviserConfig | undefined,
  gate: GateKey,
): { agent: string; model: string } | undefined =>
  gateValidators?.[gate] ?? gateValidators?.[siblingGate(gate)] ?? adviser;

const UNLIMITED_RETRY_VALUES = new Set(['unlimited', 'infinite', 'inf']);

export const parseMaxRetries = (value: string | number | null | undefined): number => {
  if (value === null || value === undefined || value === '') {
    return DEFAULT_MAX_RETRIES;
  }

  if (typeof value === 'string' && UNLIMITED_RETRY_VALUES.has(value.trim().toLowerCase())) {
    return UNLIMITED_RETRIES;
  }

  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MAX_RETRIES;
  }

  const normalized = Math.floor(parsed);
  return normalized < 0 ? UNLIMITED_RETRIES : normalized;
};

export const formatMaxRetries = (value: number): string =>
  value < 0 ? 'unlimited' : String(value);

export const hasRetryBudgetRemaining = (retryCount: number, maxRetries: number): boolean =>
  maxRetries < 0 || retryCount < maxRetries;

export const parseTimeoutMinutes = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return null;
  }

  return Math.floor(parsed);
};

export const nonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/** Path of the per-project raw config file — the single source of truth for dispatch settings. */
export const stateConfigFilePath = (projectPath: string): string =>
  path.join(projectPath, '.tenet', '.state', 'config.json');

/**
 * Live config.json reader for long-lived processes (the MCP server): every call
 * is one synchronous read + parse, so each dispatch sees the current file with
 * no watcher or mtime cache to go stale (the file is a few hundred bytes and
 * dispatches are seconds-to-minutes apart).
 *
 * Keep-last-good: a malformed file, a torn mid-write read, or ENOENT after a
 * boot that already saw the file returns the last successfully parsed object
 * instead of silently resetting dispatch to defaults (today's readers fail to
 * `{}`). A process that never saw a valid file keeps the initial `{}` —
 * fresh-project behavior. Non-object JSON (arrays, null, scalars) counts as
 * malformed, not as a config.
 */
export const createLiveStateConfigReader = (
  configPath: string,
): (() => Record<string, unknown>) => {
  let lastGood: Record<string, unknown> = {};
  return () => {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        lastGood = raw as Record<string, unknown>;
      }
    } catch {
      // Missing, unreadable, empty, torn, or non-object JSON — keep last good.
    }
    return lastGood;
  };
};

/** A scalar config value in string or number form; anything else reads as unset. */
const asScalar = (value: unknown): string | number | null | undefined =>
  typeof value === 'string' || typeof value === 'number' ? value : undefined;

/**
 * One dispatch's view of config.json: the raw object plus every parsed surface
 * (agent/model pairs, default agent, retry/timeout scalars) derived from it.
 * All agent + model + args + scalar resolution inside one dispatch goes through
 * a single snapshot, so a config edit mid-dispatch can never split the executed
 * agent from its pinned model or from the validator pair the tools report.
 */
export type DispatchConfigSnapshot = {
  /** The raw config.json object — the single source for every derived view. */
  raw: Record<string, unknown>;
  /** Adviser / worker-model / validator-gate pairs (see parseAgentModelConfig). */
  pairs: AgentModelConfig;
  /** default_agent, trimmed; undefined when unset (dispatch then fails closed). */
  defaultAgent: string | undefined;
  /** max_retries as of this snapshot — stamped per job at creation. */
  maxRetries: number;
  /** timeout_minutes as of this snapshot — applied per invocation at execution. */
  timeoutMinutes: number | null;
};

/** Parse one raw config object into the per-dispatch snapshot (pure). */
export const buildDispatchConfigSnapshot = (raw: Record<string, unknown>): DispatchConfigSnapshot => ({
  raw,
  pairs: parseAgentModelConfig(raw),
  defaultAgent: nonEmptyString(raw['default_agent']),
  maxRetries: parseMaxRetries(asScalar(raw['max_retries'])),
  timeoutMinutes: parseTimeoutMinutes(asScalar(raw['timeout_minutes'])),
});

/** A pair is active only when both keys are non-empty; otherwise it collapses to unset. */
const pairFromKeys = (
  agent: string | undefined,
  model: string | undefined,
): { agent: string; model: string } | undefined =>
  agent && model ? { agent, model } : undefined;

/**
 * Resolve adviser / worker-model / validator-gate settings from the raw
 * `.tenet/.state/config.json` object. Called per dispatch through
 * buildDispatchConfigSnapshot — never via StateStore (the SQLite config table
 * holds only runtime-written keys; see the v3 config-row purge in migrations).
 *
 * The adviser and each validator gate are active only when BOTH of their keys
 * are set: a partially configured pair (one key written via flag) must behave
 * exactly like an unset one. Gates collapse independently, so one complete
 * gate pair stays active while the other falls through the chain.
 */
export const parseAgentModelConfig = (
  config: Record<string, unknown> | null | undefined,
): AgentModelConfig => {
  const adviserAgent = nonEmptyString(config?.adviser_agent);
  const adviserModel = nonEmptyString(config?.adviser_model);

  const clarity = pairFromKeys(nonEmptyString(config?.clarity_agent), nonEmptyString(config?.clarity_model));
  const readiness = pairFromKeys(
    nonEmptyString(config?.readiness_agent),
    nonEmptyString(config?.readiness_model),
  );
  const gateValidators = clarity || readiness ? { clarity, readiness } : undefined;

  return {
    adviser: adviserAgent && adviserModel ? { agent: adviserAgent, model: adviserModel } : undefined,
    defaultAgentModel: nonEmptyString(config?.default_agent_model),
    gateValidators,
  };
};
