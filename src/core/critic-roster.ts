import fs from 'node:fs';
import path from 'node:path';
import type { JobType } from '../types/index.js';

/**
 * Configurable evaluation critics (#6).
 *
 * The critic set is a project artifact at `.tenet/critics.json`, read live from
 * disk at every `tenet_start_eval` call (same live-read precedent as the
 * `eval_parallel_safe:{feature}` config key). The three built-in critics are the
 * default; a project can disable any built-in and append custom critics whose
 * prompts live as markdown under `.tenet/critics/`.
 *
 * This module is deliberately free of DB/state concerns — it parses a file into
 * a resolved roster. `tenet_start_eval` consumes it; `job-manager`'s blocking-
 * resume gate reads the `expected_eval_stages` the tool stamps onto each critic.
 */

export type BuiltinCriticId = 'code_critic' | 'test_critic' | 'interaction_e2e';

export const BUILTIN_CRITIC_IDS: readonly BuiltinCriticId[] = [
  'code_critic',
  'test_critic',
  'interaction_e2e',
];

/** Stages the resume gate waits for when a job predates roster stamping. */
export const DEFAULT_EVAL_STAGES: readonly string[] = [
  'code_critic',
  'test_critic',
  'interaction_e2e',
];

/** Custom critics may reuse either of these job types (no new JobType needed). */
const VALID_CUSTOM_JOB_TYPES: readonly JobType[] = ['critic_eval', 'interaction_e2e'];

const BUILTIN_STAGE: Record<BuiltinCriticId, string> = {
  code_critic: 'code_critic',
  test_critic: 'test_critic',
  interaction_e2e: 'interaction_e2e',
};

const BUILTIN_JOB_TYPE: Record<BuiltinCriticId, JobType> = {
  code_critic: 'critic_eval',
  test_critic: 'eval',
  interaction_e2e: 'interaction_e2e',
};

/**
 * Legacy `.tenet/critics.json` files authored before the rename use the id
 * `playwright_eval`. Map that onto the current built-in so those files keep
 * resolving without a manual edit. This is the only place the legacy string is
 * recognized — the DB migration rewrites stored rows, but user-authored files
 * can't be auto-rewritten, hence this alias.
 */
const LEGACY_BUILTIN_ID_ALIAS: Readonly<Record<string, BuiltinCriticId>> = {
  playwright_eval: 'interaction_e2e',
};

/** Raw shape of one entry in `.tenet/critics.json`. */
export type CriticRosterEntry = {
  id: string;
  builtin?: boolean;
  enabled?: boolean;
  /** Custom only — the `eval_stage` name. Defaults to `id`. */
  stage?: string;
  /** Custom only — `critic_eval` (default) or `interaction_e2e`. */
  job_type?: JobType;
  /** Custom only — project-relative path to a markdown prompt. */
  prompt_file?: string;
};

/** A critic after resolution, ready for dispatch. */
export type ResolvedCritic = {
  id: string;
  builtin: boolean;
  enabled: boolean;
  stage: string;
  jobType: JobType;
  /** Custom only — project-relative path to the prompt markdown. */
  promptFile?: string;
};

export const DEFAULT_ROSTER: readonly ResolvedCritic[] = BUILTIN_CRITIC_IDS.map((id) => ({
  id,
  builtin: true,
  enabled: true,
  stage: BUILTIN_STAGE[id],
  jobType: BUILTIN_JOB_TYPE[id],
}));

const isBuiltinId = (id: string): id is BuiltinCriticId =>
  (BUILTIN_CRITIC_IDS as readonly string[]).includes(id);

const isJobType = (value: unknown): value is JobType =>
  typeof value === 'string' && (VALID_CUSTOM_JOB_TYPES as readonly string[]).includes(value as JobType);

/**
 * Resolve a parsed `.tenet/critics.json` payload into an ordered roster.
 *
 * Pure (no fs) so it can be unit-tested directly. Semantics:
 * - Invalid payload → default 3 built-ins.
 * - Built-ins omitted from an otherwise-valid file stay enabled and are appended
 *   in canonical order (lenient — a file that only lists customs still gets the
 *   3 built-ins).
 * - Duplicate ids are dropped (first wins).
 * - A custom entry with a missing/invalid `job_type` defaults to `critic_eval`;
 *   a missing `stage` defaults to its `id`. A missing `prompt_file` is kept
 *   (resolved later — the tool skips the critic with a warning if the file
 *   doesn't exist at dispatch time).
 */
export const resolveRoster = (raw: unknown): ResolvedCritic[] => {
  if (!raw || typeof raw !== 'object') {
    return DEFAULT_ROSTER.map((c) => ({ ...c }));
  }

  const critics = (raw as { critics?: unknown }).critics;
  if (!Array.isArray(critics)) {
    return DEFAULT_ROSTER.map((c) => ({ ...c }));
  }

  const resolved: ResolvedCritic[] = [];
  const usedIds = new Set<string>();
  const seenBuiltins = new Set<BuiltinCriticId>();

  for (const entry of critics) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const e = entry as CriticRosterEntry;
    if (typeof e.id !== 'string' || e.id.length === 0) {
      continue;
    }
    // Legacy critics.json files use the pre-rename id `playwright_eval`; map it
    // onto the current built-in so those files keep resolving without an edit.
    const id = LEGACY_BUILTIN_ID_ALIAS[e.id] ?? e.id;
    if (usedIds.has(id)) {
      continue;
    }

    if (e.builtin === true || isBuiltinId(id)) {
      // Built-in: only `enabled` (and presence/order) are meaningful.
      if (!isBuiltinId(id)) {
        // `builtin: true` asserted for an unknown id — treat as misconfigured, skip.
        continue;
      }
      seenBuiltins.add(id);
      resolved.push({
        id,
        builtin: true,
        enabled: e.enabled !== false,
        stage: BUILTIN_STAGE[id],
        jobType: BUILTIN_JOB_TYPE[id],
      });
      usedIds.add(id);
    } else {
      const stage = typeof e.stage === 'string' && e.stage.length > 0 ? e.stage : id;
      const jobType: JobType = isJobType(e.job_type) ? e.job_type : 'critic_eval';
      const promptFile = typeof e.prompt_file === 'string' && e.prompt_file.length > 0 ? e.prompt_file : undefined;
      resolved.push({
        id,
        builtin: false,
        enabled: e.enabled !== false,
        stage,
        jobType,
        promptFile,
      });
      usedIds.add(id);
    }
  }

  // Append built-ins the file omitted, in canonical order.
  for (const id of BUILTIN_CRITIC_IDS) {
    if (!seenBuiltins.has(id)) {
      resolved.push({
        id,
        builtin: true,
        enabled: true,
        stage: BUILTIN_STAGE[id],
        jobType: BUILTIN_JOB_TYPE[id],
      });
    }
  }

  return resolved;
};

export type LoadedRoster = {
  critics: ResolvedCritic[];
  /** Present when the roster file existed but could not be parsed. */
  warning?: string;
};

/**
 * Read + resolve `.tenet/critics.json` for a project. Never throws — a missing
 * or unreadable file falls back to the 3 built-ins (today's behavior).
 */
export const loadCriticRoster = (projectPath: string): LoadedRoster => {
  const rosterPath = path.join(projectPath, '.tenet', 'critics.json');
  if (!fs.existsSync(rosterPath)) {
    return { critics: DEFAULT_ROSTER.map((c) => ({ ...c })) };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      critics: DEFAULT_ROSTER.map((c) => ({ ...c })),
      warning: `Could not parse ${rosterPath} (${message}); using the 3 built-in critics.`,
    };
  }

  return { critics: resolveRoster(raw) };
};
