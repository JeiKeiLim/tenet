import { execSync } from 'node:child_process';
import path from 'node:path';
import { promptYesNo, readStateConfig, writeStateConfig } from './init.js';

const TENET_REPO = 'JeiKeiLim/tenet';
const REPO_URL = 'https://github.com/JeiKeiLim/tenet';
const GH_TIMEOUT_MS = 6_000;

/**
 * Read the per-project "already a stargazer" timestamp from
 * .tenet/.state/config.json (under the `star_nudge` key). Returns undefined when
 * not set, the file is missing, or the JSON is invalid.
 */
const readStarredAt = (projectPath: string): string | undefined => {
  const tenetRoot = path.join(projectPath, '.tenet');
  return readStateConfig(tenetRoot).star_nudge?.starredAt;
};

/**
 * Record the stargazer timestamp into .tenet/.state/config.json, preserving all
 * other config fields. Lives under .state/ (gitignored) so it is local
 * machine state, not committed or shared.
 */
const writeStarredAt = (projectPath: string, starredAt: string): void => {
  const tenetRoot = path.join(projectPath, '.tenet');
  const config = readStateConfig(tenetRoot);
  writeStateConfig(tenetRoot, {
    ...config,
    star_nudge: { ...(config.star_nudge ?? {}), starredAt },
  });
};

/**
 * Silent check via the GitHub CLI for whether the authenticated user has
 * starred the Tenet repo.
 *
 * @returns true if starred (HTTP 204); false if confirmed NOT starred (404);
 *   null if we cannot tell (gh missing / not authenticated / offline). Never
 *   throws.
 */
export const hasStarredViaGh = (): boolean | null => {
  try {
    execSync(`gh api user/starred/${TENET_REPO}`, {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: GH_TIMEOUT_MS,
    });
    return true;
  } catch (error) {
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error
        ? String((error as { stderr: Buffer | string }).stderr)
        : '';
    const message = error instanceof Error ? error.message : String(error);
    // gh maps any non-2xx HTTP response to exit code 1; the HTTP status lives in
    // stderr text. A 404 confirms "not starred"; anything else (auth, network,
    // gh-not-installed) means we cannot tell.
    return /404/.test(`${stderr} ${message}`) ? false : null;
  }
};

/** Best-effort star via gh. Returns true on success. Never throws. */
const starViaGh = (): boolean => {
  try {
    execSync(`gh api -X PUT user/starred/${TENET_REPO}`, {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: GH_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
};

type MaybeStarNudgeOptions = {
  /** Defaults to process.stdin.isTTY — injectable for tests. */
  isTty?: boolean;
  /** Defaults to hasStarredViaGh — injectable for tests. */
  ghCheck?: () => boolean | null;
  /** Defaults to the real starViaGh (best-effort gh PUT) — injectable for tests. */
  star?: () => boolean;
  /** Defaults to the real promptYesNo — injectable for tests. */
  prompt?: (question: string, defaultYes?: boolean) => Promise<boolean>;
  /** Defaults to () => new Date().toISOString() — injectable for tests. */
  now?: () => string;
};

/**
 * Polite, opt-out star nudge run at the end of interactive `tenet init` /
 * `tenet init --upgrade`. State is per-project in .tenet/.state/config.json.
 *
 * Suppression is permanent only once the user is recorded as a stargazer: gh
 * confirms it, or the user accepts and the best-effort gh PUT succeeds.
 * Declining ("no") records nothing, so the next interactive run asks again — a
 * decline is "not now", not "never".
 *
 * Skipped (no state change) when TENET_NO_STAR_NUDGE is set or the run is
 * non-interactive (no TTY / --yes). Never throws.
 */
export const maybeStarNudge = async (
  projectPath: string,
  opts: MaybeStarNudgeOptions = {},
): Promise<void> => {
  const isTty = opts.isTty ?? process.stdin.isTTY;
  const ghCheck = opts.ghCheck ?? hasStarredViaGh;
  const star = opts.star ?? starViaGh;
  const prompt = opts.prompt ?? promptYesNo;
  const now = opts.now ?? (() => new Date().toISOString());

  try {
    if (process.env.TENET_NO_STAR_NUDGE) {
      return;
    }

    if (!isTty) {
      return;
    }

    if (readStarredAt(projectPath)) {
      return; // already a stargazer — never ask this project again
    }

    let starred: boolean | null = null;
    try {
      starred = ghCheck();
    } catch {
      starred = null;
    }

    if (starred === true) {
      writeStarredAt(projectPath, now());
      return; // silent — never ask a supporter
    }

    console.log(`\n⭐ Enjoying Tenet? Star it on GitHub: ${REPO_URL}`);
    const yes = await prompt('Star Tenet on GitHub now?', false);
    if (yes) {
      if (star()) {
        writeStarredAt(projectPath, now());
        console.log('  Starred. Thanks for supporting Tenet!');
      } else {
        console.log(`  Could not star automatically — please star manually: ${REPO_URL}`);
        // Not starred yet → will re-ask on the next interactive run.
      }
    }
    // "no" → record nothing → re-ask next interactive run.
  } catch {
    // The nudge must never break init/upgrade.
  }
};
