export const UNLIMITED_RETRIES = -1;
export const DEFAULT_MAX_RETRIES = UNLIMITED_RETRIES;
export const DEFAULT_JOB_TIMEOUT_MINUTES = 120;
export const DEFAULT_JOB_TIMEOUT_MS = DEFAULT_JOB_TIMEOUT_MINUTES * 60 * 1000;

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
