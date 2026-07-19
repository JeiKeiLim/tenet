import path from 'node:path';
import readline from 'node:readline/promises';
import {
  NON_TERMINAL_JOB_STATUSES,
  StateStore,
  TERMINAL_JOB_STATUSES,
  type CleanupPreview,
  type CleanupPruneResult,
  type CleanupReclaimEntry,
} from '../core/state-store.js';
import { formatBytes, timestamp } from './db.js';
import { promptYesNo } from './init.js';

export type CleanupMode = 'all' | 'events-only';

export type CleanupOptions = {
  mode: CleanupMode;
  cutoffMs: number;
  dryRun: boolean;
  noArchive: boolean;
};

export type CleanupFlags = {
  keepDays?: number;
  before?: string;
  mode?: CleanupMode;
  dryRun?: boolean;
  yes?: boolean;
  noArchive?: boolean;
};

export type CleanupRunResult =
  | ({ kind: 'dry-run' } & Pick<CleanupOptions, 'mode' | 'cutoffMs'>)
  | CleanupPruneResult;

const MS_PER_DAY = 86_400_000;
const CANONICAL_KEEP_DAYS = [7, 15, 30] as const;
/** A cutoff reclaiming less than this is a no-op and dropped from the menu. */
const NOOP_RECLAIM_BYTES = 1024 * 1024;

export const cutoffFromKeepDays = (days: number, now = Date.now()): number => now - days * MS_PER_DAY;

const canonicalCutoffsMs = (now: number): number[] => {
  const cutoffs = [now, ...CANONICAL_KEEP_DAYS.map((days) => cutoffFromKeepDays(days, now))];
  return Array.from(new Set(cutoffs));
};

const formatCutoffDate = (cutoffMs: number): string => new Date(cutoffMs).toISOString().slice(0, 10);

const nonTerminalCount = (preview: CleanupPreview): number =>
  NON_TERMINAL_JOB_STATUSES.reduce((sum, status) => sum + (preview.statusCounts[status] ?? 0), 0);

const resultsBytes = (preview: CleanupPreview): number =>
  preview.categoryBytes.jobsOutput + preview.categoryBytes.jobsError;

const liveTextTotal = (preview: CleanupPreview): number =>
  preview.categoryBytes.eventsData + resultsBytes(preview) + preview.categoryBytes.jobsParams;

const pctOf = (bytes: number, total: number): string => {
  if (total <= 0) return '   -';
  return `${String(Math.round((bytes / total) * 100)).padStart(3)}%`;
};

/** Unconditional heads-up — printed on every invocation (design decision #12). */
export const CLEANUP_WARNING =
  '⚠  tenet db cleanup deletes old finished jobs and compacts the database.\n' +
  '    It is safe to run any time (in-progress jobs are never touched), but for a\n' +
  '    large DB prefer running it between autonomous runs, not during one.';

const printWarning = (): void => {
  console.warn(CLEANUP_WARNING);
};

const archivePathFor = (projectPath: string): string =>
  path.join(projectPath, '.tenet', 'archive', `cleanup-${timestamp()}.jsonl`);

const scanPreview = (projectPath: string, cutoffsMs: number[]): CleanupPreview => {
  const store = StateStore.openReadonly(projectPath);
  try {
    return store.getCleanupPreview(cutoffsMs);
  } finally {
    store.close();
  }
};

/**
 * Characterize the DB so the opening line is honest for any shape. If most of
 * the file is already-reclaimed freelist, say so (VACUUM-alone would help);
 * otherwise tell the user shrinking means deleting real data. Pure.
 */
const characterizeSize = (preview: CleanupPreview): string => {
  const vacuumReclaimable = preview.freelistCount * preview.pageSize;
  if (preview.fileBytes > 0 && vacuumReclaimable > preview.fileBytes * 0.05) {
    return (
      `tenet.db is ${formatBytes(preview.fileBytes)} — about ${formatBytes(vacuumReclaimable)} of that ` +
      `is already-reclaimed space; VACUUM can shrink it without deleting anything.`
    );
  }
  return (
    `tenet.db is ${formatBytes(preview.fileBytes)} — almost entirely real data, so there's no ` +
    `quick "compact"; shrinking it means deleting old work.`
  );
};

/**
 * The "lay of the land" block: total size + characterization, the two
 * guarantees, and the per-category byte breakdown. Pure (returns the string;
 * the caller prints). Every figure is computed from the live DB upstream.
 */
export const renderCleanupPreview = (preview: CleanupPreview): string => {
  const inProgress = nonTerminalCount(preview);
  const total = liveTextTotal(preview);
  const lines: string[] = [];

  lines.push(characterizeSize(preview));
  lines.push('Two things you can count on:');
  lines.push(
    `  • In-progress work (${inProgress} job${inProgress === 1 ? '' : 's'} running or queued) is never touched.`,
  );
  lines.push('  • Finished jobs we remove are archived to .tenet/archive/ first, so your');
  lines.push('    results and critic verdicts stay recoverable.');
  lines.push('');
  lines.push("What's taking up the space:");
  lines.push(
    `  Activity logs — the step-by-step history of each job ... ${formatBytes(preview.categoryBytes.eventsData).padStart(9)}  ${pctOf(preview.categoryBytes.eventsData, total)}`,
  );
  lines.push(
    `  Results & reviews — job outputs and critic verdicts ..... ${formatBytes(resultsBytes(preview)).padStart(9)}  ${pctOf(resultsBytes(preview), total)}`,
  );
  lines.push(
    `  Prompts sent to workers ................................. ${formatBytes(preview.categoryBytes.jobsParams).padStart(9)}  ${pctOf(preview.categoryBytes.jobsParams, total)}`,
  );
  return lines.join('\n');
};

export const renderPruneResult = (result: CleanupPruneResult, archivePath?: string): string => {
  const lines: string[] = [];
  lines.push(
    `Removed ${result.deletedJobs} finished job(s) and ${result.deletedEvents} event log(s)` +
      (result.orphanEventsSwept > 0 ? `; swept ${result.orphanEventsSwept} orphan event log(s)` : '') +
      '.',
  );
  if (archivePath && result.archivedJobs > 0) {
    lines.push(`Archived ${result.archivedJobs} job record(s) to ${path.relative(process.cwd(), archivePath) || archivePath}.`);
  } else if (archivePath && result.archivedJobs === 0) {
    lines.push('No jobs removed; archive not written.');
  }
  const reclaimed = Math.max(0, result.bytesBefore - result.bytesAfter);
  if (result.vacuumed) {
    lines.push(`tenet.db: ${formatBytes(result.bytesBefore)} → ${formatBytes(result.bytesAfter)} (reclaimed ${formatBytes(reclaimed)}).`);
  } else {
    lines.push(
      `tenet.db: ${formatBytes(result.bytesBefore)} → ${formatBytes(result.bytesAfter)}. ` +
        `VACUUM was skipped (${result.vacuumError ?? 'unknown reason'}); re-run later to compact.`,
    );
  }
  return lines.join('\n');
};

// --- Menu (pure construction) -------------------------------------------------

type MenuPick =
  | { kind: 'run'; mode: CleanupMode; cutoffMs: number }
  | { kind: 'prompt-date' }
  | { kind: 'dry-run-info' };

type MenuItem = { n: number; label: string; pick: MenuPick };
type MenuGroup = { title: string; items: MenuItem[] };
type Menu = { groups: MenuGroup[]; byNumber: Map<number, MenuItem> };

const reclaimEntry = (preview: CleanupPreview, cutoffMs: number): CleanupReclaimEntry | undefined =>
  preview.reclaim.find((r) => r.cutoffMs === cutoffMs);

/**
 * Build the numbered menu from the live reclaim curve, dropping no-op cutoffs.
 * Pure — the readline interaction lives in promptCleanupChoice. Numbers are
 * assigned 1..N; [0] is cancel (handled by the prompt).
 */
export const buildMenu = (preview: CleanupPreview, now: number): Menu => {
  const groups: MenuGroup[] = [];
  const byNumber = new Map<number, MenuItem>();
  let n = 0;
  const addItem = (groupTitle: string, label: string, pick: MenuPick): { group: string } => {
    n += 1;
    const item: MenuItem = { n, label, pick };
    byNumber.set(n, item);
    let group = groups.find((g) => g.title === groupTitle);
    if (!group) {
      group = { title: groupTitle, items: [] };
      groups.push(group);
    }
    group.items.push(item);
    return { group: groupTitle };
  };

  for (const days of CANONICAL_KEEP_DAYS) {
    const entry = reclaimEntry(preview, cutoffFromKeepDays(days, now));
    if (entry && entry.all.bytes >= NOOP_RECLAIM_BYTES) {
      addItem(
        'Remove old finished work   (finished = completed, failed, or cancelled)',
        `keep the last ${days} days → removes ${entry.all.jobCount} job(s), frees ~${formatBytes(entry.all.bytes)}`,
        { kind: 'run', mode: 'all', cutoffMs: entry.cutoffMs },
      );
    }
  }
  addItem(
    'Remove old finished work   (finished = completed, failed, or cancelled)',
    'keep everything since a specific date…',
    { kind: 'prompt-date' },
  );

  for (const days of [7, 15]) {
    const entry = reclaimEntry(preview, cutoffFromKeepDays(days, now));
    if (entry && entry.eventsOnly.bytes >= NOOP_RECLAIM_BYTES) {
      addItem(
        'Trim logs only — keep all results and finished jobs; drop old activity logs',
        `drop logs older than ${days} days → frees ~${formatBytes(entry.eventsOnly.bytes)}, all results kept`,
        { kind: 'run', mode: 'events-only', cutoffMs: entry.cutoffMs },
      );
    }
  }

  const resetEntry = reclaimEntry(preview, now);
  if (resetEntry && resetEntry.all.jobCount > 0) {
    addItem(
      'Reset',
      `remove ALL finished work → removes ${resetEntry.all.jobCount} job(s), frees ~${formatBytes(resetEntry.all.bytes)}`,
      { kind: 'run', mode: 'all', cutoffMs: now },
    );
  }

  addItem('More', 'show the full reclaim breakdown (changes nothing)', { kind: 'dry-run-info' });

  return { groups, byNumber };
};

const printMenu = (menu: Menu): void => {
  console.log('\nWhat would you like to do?\n');
  for (const group of menu.groups) {
    console.log(`  ${group.title}`);
    for (const item of group.items) {
      console.log(`    [${item.n}] ${item.label}`);
    }
    console.log('');
  }
  console.log('  [0] cancel');
};

const printFullBreakdown = (preview: CleanupPreview): void => {
  console.log('\nReclaim by cutoff (computed from the live DB):');
  for (const entry of preview.reclaim) {
    const when = entry.cutoffMs >= Date.now() ? 'all finished work' : `older than ${formatCutoffDate(entry.cutoffMs)}`;
    console.log(
      `  ${when.padEnd(16)} remove-work: ${String(entry.all.jobCount).padStart(5)} job(s), ~${formatBytes(entry.all.bytes).padStart(9)}` +
        `   | logs-only: ~${formatBytes(entry.eventsOnly.bytes).padStart(9)}`,
    );
  }
  if (preview.orphanEvents.count > 0) {
    console.log(`  (+ ${preview.orphanEvents.count} orphan event log(s), ~${formatBytes(preview.orphanEvents.bytes)} — swept in every mode)`);
  }
};

// --- Interaction --------------------------------------------------------------

const promptCleanupChoice = async (
  preview: CleanupPreview,
  now: number,
  flags: CleanupFlags,
): Promise<CleanupOptions | null> => {
  const menu = buildMenu(preview, now);
  printMenu(menu);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = (await rl.question('\nSelect: ')).trim();
      if (answer === '0' || answer === '') return null;
      const num = Number.parseInt(answer, 10);
      const item = menu.byNumber.get(num);
      if (!item) {
        console.log('Invalid selection.');
        continue;
      }
      if (item.pick.kind === 'dry-run-info') {
        printFullBreakdown(preview);
        printMenu(menu);
        continue;
      }
      if (item.pick.kind === 'prompt-date') {
        const dateStr = (await rl.question('Keep everything since (YYYY-MM-DD): ')).trim();
        const ms = Date.parse(dateStr);
        if (!Number.isFinite(ms)) {
          console.log('Invalid date — use YYYY-MM-DD.');
          continue;
        }
        return { mode: flags.mode ?? 'all', cutoffMs: ms, dryRun: false, noArchive: flags.noArchive === true };
      }
      return {
        mode: item.pick.mode,
        cutoffMs: item.pick.cutoffMs,
        dryRun: false,
        noArchive: flags.noArchive === true,
      };
    }
  } finally {
    rl.close();
  }
};

const resolveFlaggedCutoff = (flags: CleanupFlags, now: number): number | null => {
  if (typeof flags.keepDays === 'number') return cutoffFromKeepDays(flags.keepDays, now);
  if (typeof flags.before === 'string') {
    const ms = Date.parse(flags.before);
    if (!Number.isFinite(ms)) {
      throw new Error(`--before could not be parsed as a date: ${flags.before} (try YYYY-MM-DD)`);
    }
    return ms;
  }
  return null;
};

/** Execute a decided plan. Prints the plan + result. Core, side-effecting. */
export const executeCleanup = (
  projectPath: string,
  opts: CleanupOptions,
  preview: CleanupPreview,
): CleanupRunResult => {
  const entry = reclaimEntry(preview, opts.cutoffMs);
  if (opts.mode === 'all') {
    console.log(
      `\nPlan: remove ${entry?.all.jobCount ?? 0} finished job(s) older than ${formatCutoffDate(opts.cutoffMs)} → frees ~${formatBytes(entry?.all.bytes ?? 0)}.`,
    );
  } else {
    console.log(
      `\nPlan: drop ${entry?.eventsOnly.eventCount ?? 0} activity log(s) older than ${formatCutoffDate(opts.cutoffMs)} → frees ~${formatBytes(entry?.eventsOnly.bytes ?? 0)}; all results kept.`,
    );
  }

  if (opts.dryRun) {
    console.log('Dry run — nothing was changed.');
    return { kind: 'dry-run', mode: opts.mode, cutoffMs: opts.cutoffMs };
  }

  const archivePath = opts.noArchive ? undefined : archivePathFor(projectPath);
  const store = new StateStore(projectPath);
  try {
    const result = store.pruneCleanup({ mode: opts.mode, cutoffMs: opts.cutoffMs, archivePath });
    console.log(renderPruneResult(result, archivePath));
    return result;
  } finally {
    store.close();
  }
};

const hasReclaimableWork = (preview: CleanupPreview): boolean =>
  preview.reclaim.some(
    (r) => r.all.bytes >= NOOP_RECLAIM_BYTES || r.eventsOnly.bytes >= NOOP_RECLAIM_BYTES,
  ) || TERMINAL_JOB_STATUSES.some((status) => (preview.statusCounts[status] ?? 0) > 0);

/**
 * Entry point for the `tenet db cleanup` action handler. Interactive (TTY + no
 * decision flags) shows the menu; otherwise flag-driven. Always prints the
 * unconditional warning and the lay-of-the-land preview first.
 */
export const runCleanupCommand = async (projectPath: string, flags: CleanupFlags): Promise<void> => {
  printWarning();
  const now = Date.now();
  const preview = scanPreview(projectPath, canonicalCutoffsMs(now));
  console.log(`\n${renderCleanupPreview(preview)}`);

  if (!hasReclaimableWork(preview)) {
    console.log('\nNothing to clean up — tenet.db has no old finished work to reclaim yet.');
    return;
  }

  const hasDecisionFlag = typeof flags.keepDays === 'number' || typeof flags.before === 'string';
  const interactive = process.stdin.isTTY === true && !hasDecisionFlag;

  let opts: CleanupOptions;
  if (interactive) {
    const choice = await promptCleanupChoice(preview, now, flags);
    if (choice === null) {
      console.log('\nCancelled. Nothing was changed.');
      return;
    }
    opts = choice;
  } else {
    const cutoffMs = resolveFlaggedCutoff(flags, now);
    if (cutoffMs === null) {
      console.log(
        '\nNon-interactive mode — showing the preview only. To reclaim space, pass ' +
          '--keep-days <N>, --before <YYYY-MM-DD>, and/or --mode events-only.',
      );
      return;
    }
    opts = {
      mode: flags.mode ?? 'all',
      cutoffMs,
      dryRun: flags.dryRun === true,
      noArchive: flags.noArchive === true,
    };
  }

  if (!opts.dryRun && interactive && flags.yes !== true) {
    console.log('');
    const proceed = await promptYesNo('Proceed with cleanup?', false);
    if (!proceed) {
      console.log('Cancelled. Nothing was changed.');
      return;
    }
  }

  executeCleanup(projectPath, opts, preview);
};
