import fs from 'node:fs';
import path from 'node:path';

export async function verify(workdir: string): Promise<{ passed: boolean; details: string }> {
  const checks: string[] = [];
  const failures: string[] = [];

  const htmlPath = path.join(workdir, 'index.html');
  if (!fs.existsSync(htmlPath)) {
    failures.push('index.html missing');
    return summarize(checks, failures);
  }
  checks.push('index.html exists');

  const html = fs.readFileSync(htmlPath, 'utf8');

  // Structural spot-checks (regex over raw HTML — good enough for a spec this simple).
  if (!/Click Counter/i.test(html)) failures.push('missing "Click Counter" heading text');
  else checks.push('heading present');

  if (!/id=["']increment-btn["']/.test(html)) failures.push('button id "increment-btn" missing');
  else checks.push('button element with correct id');

  if (!/id=["']count-display["']/.test(html)) failures.push('span id "count-display" missing');
  else checks.push('count display element with correct id');

  // Ensure there's at least some click handling.
  if (!/addEventListener\(['"]click['"]|onclick=/.test(html)) {
    failures.push('no click handler found (addEventListener or onclick)');
  } else {
    checks.push('click handler wired');
  }

  // No external scripts (iron law)
  if (/<script[^>]+src=["']https?:\/\//.test(html)) {
    failures.push('external <script src="https://..."> present; spec forbids it');
  }

  // Test file presence (soft check)
  const testPath = path.join(workdir, 'tests', 'click-counter.test.ts');
  if (fs.existsSync(testPath)) {
    checks.push('test file exists');
  } else {
    failures.push('tests/click-counter.test.ts missing');
  }

  return summarize(checks, failures);
}

const summarize = (checks: string[], failures: string[]): { passed: boolean; details: string } => {
  const passed = failures.length === 0;
  const details = passed
    ? `passed ${checks.length} checks: ${checks.join('; ')}`
    : `failures: ${failures.join('; ')}`;
  return { passed, details };
};
