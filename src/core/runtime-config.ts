export const UNLIMITED_RETRIES = -1;
export const DEFAULT_MAX_RETRIES = UNLIMITED_RETRIES;
export const DEFAULT_JOB_TIMEOUT_MINUTES = 120;
export const DEFAULT_JOB_TIMEOUT_MS = DEFAULT_JOB_TIMEOUT_MINUTES * 60 * 1000;

/** Resolved adviser settings — present only when both config keys are set. */
export type AdviserConfig = {
  agent: string;
  model: string;
};

export type AgentModelConfig = {
  adviser?: AdviserConfig;
  defaultAgentModel?: string;
};

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

const nonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * Resolve adviser / worker-model settings from the raw `.tenet/.state/config.json`
 * object at server startup. This deliberately bypasses StateStore's loadFileConfig
 * whitelist (it only syncs default_agent/max_retries/timeout_minutes, silently
 * ignoring new keys) — the same server-startup read that supplies the per-adapter
 * *_args values is the one path that sees these keys.
 *
 * The adviser is active only when BOTH keys are set: a partially configured
 * adviser (one key written via flag) must behave exactly like an unset one.
 */
export const parseAgentModelConfig = (
  config: Record<string, unknown> | null | undefined,
): AgentModelConfig => {
  const adviserAgent = nonEmptyString(config?.adviser_agent);
  const adviserModel = nonEmptyString(config?.adviser_model);

  return {
    adviser: adviserAgent && adviserModel ? { agent: adviserAgent, model: adviserModel } : undefined,
    defaultAgentModel: nonEmptyString(config?.default_agent_model),
  };
};
