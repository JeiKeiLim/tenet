import { getPackageVersion } from '../cli/version.js';

const PACKAGE_NAME = '@jeikeilim/tenet';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 2000;

export type UpdateInfo = {
  current: string;
  latest: string;
  update_available: boolean;
  update_command: string;
};

let cachedLatest: string | undefined;
let lastCheckAt = 0;

async function fetchLatestVersion(): Promise<string | undefined> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return undefined;

    const data = (await res.json()) as { version?: string };
    return data.version;
  } catch {
    return undefined;
  }
}

function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.split('.').map(Number);
  const [lMaj, lMin, lPat] = parse(latest);
  const [cMaj, cMin, cPat] = parse(current);
  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPat > cPat;
}

/**
 * Check for updates. Non-blocking, graceful on failure.
 * Re-fetches from npm registry if cache is older than 24 hours.
 * Returns update info if a newer version exists, undefined otherwise.
 */
export async function checkForUpdate(): Promise<UpdateInfo | undefined> {
  const current = getPackageVersion();
  const now = Date.now();

  if (now - lastCheckAt > CHECK_INTERVAL_MS || !cachedLatest) {
    const latest = await fetchLatestVersion();
    if (latest) {
      cachedLatest = latest;
      lastCheckAt = now;
    }
  }

  if (!cachedLatest) return undefined;

  return {
    current,
    latest: cachedLatest,
    update_available: isNewer(cachedLatest, current),
    update_command: `npm install -g ${PACKAGE_NAME}`,
  };
}
