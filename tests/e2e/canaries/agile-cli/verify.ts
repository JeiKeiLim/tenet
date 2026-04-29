import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Verifies that BOTH slices of the agile-cli canary landed and the final
// product (slice 1 + slice 2 = key-count with --pretty) actually works.
// Runs AFTER Tenet's per-slice evaluation — this is a secondary smoke check.
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

  // 2. Test file exists with both slice 1 and slice 2 cases
  const testPath = path.join(workdir, 'tests', 'key-count.test.ts');
  if (fs.existsSync(testPath)) {
    checks.push('tests/key-count.test.ts exists');
    const testContent = fs.readFileSync(testPath, 'utf8');
    if (/--pretty|pretty/i.test(testContent)) {
      checks.push('tests cover --pretty (slice 2)');
    } else {
      failures.push('tests file missing --pretty coverage — slice 2 may not have landed');
    }
  } else {
    failures.push('tests/key-count.test.ts missing');
  }

  // 3. Build output exists (or build it ourselves)
  const distPath = path.join(workdir, 'dist', 'key-count.js');
  if (!fs.existsSync(distPath)) {
    try {
      execSync('npx tsc', {
        cwd: workdir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      });
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      failures.push(
        `tsc build failed: stdout=${(err.stdout ?? '').slice(0, 300)} stderr=${(err.stderr ?? err.message ?? '').slice(0, 300)}`,
      );
    }
  }
  if (fs.existsSync(distPath)) {
    checks.push('dist/key-count.js exists');
  }

  // 4. Smoke test BOTH the slice-1 default output and the slice-2 --pretty output
  if (fs.existsSync(distPath)) {
    const sampleDir = fs.mkdtempSync(path.join(workdir, 'verify-sample-'));
    try {
      const samplePath = path.join(sampleDir, 'sample.json');
      fs.writeFileSync(samplePath, JSON.stringify({ a: 1, b: 2, c: 3 }));

      // Slice 1: default output should match "3 keys"
      try {
        const defaultOutput = execSync(`node "${distPath}" "${samplePath}"`, {
          cwd: workdir,
          encoding: 'utf8',
          timeout: 10_000,
        }).trim();
        if (/3 keys/.test(defaultOutput)) {
          checks.push(`slice 1 happy path: "${defaultOutput}"`);
        } else {
          failures.push(`slice 1 happy path: unexpected "${defaultOutput}" (expected contains "3 keys")`);
        }
      } catch (error) {
        failures.push(
          `slice 1 smoke failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
        );
      }

      // Slice 2: --pretty output should differ from default and include the count
      try {
        const prettyOutput = execSync(`node "${distPath}" --pretty "${samplePath}"`, {
          cwd: workdir,
          encoding: 'utf8',
          timeout: 10_000,
        }).trim();
        if (/3 keys/.test(prettyOutput) && (prettyOutput.includes('✓') || /:\s*3 keys/.test(prettyOutput))) {
          checks.push(`slice 2 --pretty: "${prettyOutput}"`);
        } else {
          failures.push(`slice 2 --pretty: unexpected "${prettyOutput}" (expected ✓ marker or "<path>: 3 keys")`);
        }
      } catch (error) {
        failures.push(
          `slice 2 --pretty smoke failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
        );
      }
    } finally {
      fs.rmSync(sampleDir, { recursive: true, force: true });
    }
  }

  // 5. Decomposition file exists with per-slice sections (loose check — agents vary in formatting)
  const decompDir = path.join(workdir, '.tenet', 'decomposition');
  if (fs.existsSync(decompDir)) {
    const files = fs.readdirSync(decompDir);
    const decompFile = files.find((f) => f.endsWith('.md'));
    if (decompFile) {
      checks.push(`decomposition file exists: ${decompFile}`);
    }
  }

  const passed = failures.length === 0;
  const details = passed
    ? `passed ${checks.length} checks: ${checks.join('; ')}`
    : `failures: ${failures.join('; ')}`;
  return { passed, details };
}
