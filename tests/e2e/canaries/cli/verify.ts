import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Verifies that the key-count CLI canary was actually built and works.
// Runs AFTER Tenet's internal evaluation — this is a secondary smoke check.
export async function verify(workdir: string): Promise<{ passed: boolean; details: string }> {
  const checks: string[] = [];
  const failures: string[] = [];

  // 1. Source file exists
  const srcPath = path.join(workdir, 'src', 'key-count.ts');
  if (fs.existsSync(srcPath)) {
    checks.push('src/key-count.ts exists');
  } else {
    failures.push('src/key-count.ts missing');
  }

  // 2. Test file exists
  const testPath = path.join(workdir, 'tests', 'key-count.test.ts');
  if (fs.existsSync(testPath)) {
    checks.push('tests/key-count.test.ts exists');
  } else {
    failures.push('tests/key-count.test.ts missing');
  }

  // 3. Build output exists
  const distPath = path.join(workdir, 'dist', 'key-count.js');
  if (fs.existsSync(distPath)) {
    checks.push('dist/key-count.js exists (agent built it)');
  } else {
    // The agent may not have run tsc; try to build ourselves to get a smoke check.
    try {
      const out = execSync('npx tsc', {
        cwd: workdir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      });
      if (out && out.trim().length > 0) {
        checks.push(`tsc stdout: ${out.trim().slice(0, 200)}`);
      }
      if (fs.existsSync(distPath)) {
        checks.push('dist/key-count.js built by verify fallback');
      } else {
        const distDir = path.join(workdir, 'dist');
        const contents = fs.existsSync(distDir) ? fs.readdirSync(distDir).join(', ') : '(no dist/)';
        failures.push(`dist/key-count.js missing after tsc fallback; dist/ contains: [${contents}]`);
      }
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      failures.push(
        `tsc build failed: stdout=${(err.stdout ?? '').slice(0, 300)} stderr=${(err.stderr ?? err.message ?? '').slice(0, 300)}`,
      );
    }
  }

  // 4. Smoke test: run with a sample JSON
  if (fs.existsSync(distPath)) {
    const sampleDir = fs.mkdtempSync(path.join(workdir, 'verify-sample-'));
    try {
      const samplePath = path.join(sampleDir, 'sample.json');
      fs.writeFileSync(samplePath, JSON.stringify({ a: 1, b: 2, c: 3 }));
      try {
        const output = execSync(`node "${distPath}" "${samplePath}"`, {
          cwd: workdir,
          encoding: 'utf8',
          timeout: 10_000,
        }).trim();
        if (/3 keys/.test(output)) {
          checks.push(`happy path: produced "${output}"`);
        } else {
          failures.push(`happy path: unexpected output "${output}" (expected contains "3 keys")`);
        }
      } catch (error) {
        failures.push(
          `smoke test execution failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
        );
      }
    } finally {
      fs.rmSync(sampleDir, { recursive: true, force: true });
    }
  }

  const passed = failures.length === 0;
  const details = passed
    ? `passed ${checks.length} checks: ${checks.join('; ')}`
    : `failures: ${failures.join('; ')}`;
  return { passed, details };
}
