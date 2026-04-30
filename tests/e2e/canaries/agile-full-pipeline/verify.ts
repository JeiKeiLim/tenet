import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Verifies the full-pipeline agile canary: both planning artifacts AND built code.
export async function verify(workdir: string): Promise<{ passed: boolean; details: string }> {
  const checks: string[] = [];
  const failures: string[] = [];

  // === Planning artifact checks ===

  // 1. Spec exists with delivery_mode: agile
  const specDir = path.join(workdir, '.tenet', 'spec');
  const specFiles = fs.existsSync(specDir)
    ? fs.readdirSync(specDir).filter((f) => f.endsWith('.md'))
    : [];
  const specFile = specFiles.sort().at(-1); // latest by date prefix
  if (specFile) {
    checks.push(`spec file exists: ${specFile}`);
    const specContent = fs.readFileSync(path.join(specDir, specFile), 'utf8');
    if (/delivery_mode:\s*agile/i.test(specContent)) {
      checks.push('spec has delivery_mode: agile');
    } else {
      failures.push('spec missing delivery_mode: agile front matter');
    }
    if (/## Slice plan/i.test(specContent)) {
      checks.push('spec has Slice plan section');
      const sliceCount = (specContent.match(/### Slice \d+:/g) || []).length;
      if (sliceCount >= 2) {
        checks.push(`spec has ${sliceCount} slices`);
      } else {
        failures.push(`spec has ${sliceCount} slices (expected >= 2)`);
      }
    } else {
      failures.push('spec missing ## Slice plan section');
    }
  } else {
    failures.push('no spec file in .tenet/spec/');
  }

  // 2. Decomposition exists with slice-headed sections
  const decompDir = path.join(workdir, '.tenet', 'decomposition');
  const decompFiles = fs.existsSync(decompDir)
    ? fs.readdirSync(decompDir).filter((f) => f.endsWith('.md') && /^\d{4}-\d{2}-\d{2}/.test(f))
    : [];
  const decompFile = decompFiles.sort().at(-1);
  if (decompFile) {
    checks.push(`decomposition file exists: ${decompFile}`);
    const decompContent = fs.readFileSync(path.join(decompDir, decompFile), 'utf8');
    const sliceHeadings = decompContent.match(/## Slice \d+:/g) || [];
    if (sliceHeadings.length >= 1) {
      checks.push(`decomposition has ${sliceHeadings.length} slice section(s)`);
    } else {
      failures.push('decomposition has no ## Slice N: sections');
    }
  } else {
    failures.push('no decomposition file in .tenet/decomposition/');
  }

  // 3. Structured job files exist
  const jobsDir = path.join(workdir, '.tenet', 'jobs');
  for (const sliceFile of ['slice-1.json', 'slice-2.json']) {
    const p = path.join(jobsDir, sliceFile);
    if (fs.existsSync(p)) {
      try {
        const jobs = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (Array.isArray(jobs) && jobs.length > 0 && jobs[0].id) {
          checks.push(`${sliceFile}: ${jobs.length} job(s), first id=${jobs[0].id}`);
        } else {
          failures.push(`${sliceFile}: not a valid jobs array`);
        }
      } catch {
        failures.push(`${sliceFile}: invalid JSON`);
      }
    } else {
      failures.push(`${sliceFile} missing in .tenet/jobs/`);
    }
  }

  // === Built artifact checks ===

  // 4. Source file exists
  const srcPath = path.join(workdir, 'src', 'wc-json.ts');
  if (fs.existsSync(srcPath)) {
    checks.push('src/wc-json.ts exists');
  } else {
    failures.push('src/wc-json.ts missing');
  }

  // 5. Test file exists
  const testPath = path.join(workdir, 'tests', 'wc-json.test.ts');
  if (fs.existsSync(testPath)) {
    checks.push('tests/wc-json.test.ts exists');
    const testContent = fs.readFileSync(testPath, 'utf8');
    if (/--verbose|verbose/i.test(testContent)) {
      checks.push('tests cover --verbose (slice 2)');
    } else {
      failures.push('tests missing --verbose coverage — slice 2 may not have landed');
    }
  } else {
    failures.push('tests/wc-json.test.ts missing');
  }

  // 6. Build
  const distPath = path.join(workdir, 'dist', 'wc-json.js');
  const altDistPath = path.join(workdir, 'dist', 'src', 'wc-json.js');
  if (!fs.existsSync(distPath) && !fs.existsSync(altDistPath)) {
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
        `tsc build failed: ${(err.stderr ?? err.message ?? '').slice(0, 300)}`,
      );
    }
  }
  const resolvedDist = fs.existsSync(distPath) ? distPath : fs.existsSync(altDistPath) ? altDistPath : null;
  if (resolvedDist) {
    checks.push(fs.existsSync(distPath) ? 'dist/wc-json.js exists' : 'dist/src/wc-json.js exists (rootDir workaround)');
  } else {
    failures.push('dist/wc-json.js missing after build');
  }

  // 7. Smoke test both slices
  if (resolvedDist) {
    const sampleDir = fs.mkdtempSync(path.join(workdir, 'verify-sample-'));
    try {
      const samplePath = path.join(sampleDir, 'sample.json');
      fs.writeFileSync(samplePath, JSON.stringify({ greeting: 'hello world', name: 'tenet ai' }));

      // Slice 1: default output
      try {
        const defaultOutput = execSync(`node "${resolvedDist}" "${samplePath}"`, {
          cwd: workdir,
          encoding: 'utf8',
          timeout: 10_000,
        }).trim();
        if (/4 words/.test(defaultOutput)) {
          checks.push(`slice 1 happy path: "${defaultOutput}"`);
        } else {
          failures.push(`slice 1 happy path: unexpected "${defaultOutput}" (expected "4 words in ...")`);
        }
      } catch (error) {
        failures.push(
          `slice 1 smoke failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
        );
      }

      // Slice 2: --verbose output
      try {
        const verboseOutput = execSync(`node "${resolvedDist}" --verbose "${samplePath}"`, {
          cwd: workdir,
          encoding: 'utf8',
          timeout: 10_000,
        }).trim();
        if (/greeting/.test(verboseOutput) && /4 words/.test(verboseOutput)) {
          checks.push(`slice 2 --verbose: per-key breakdown present`);
        } else {
          failures.push(`slice 2 --verbose: unexpected "${verboseOutput}" (expected per-key breakdown + total)`);
        }
      } catch (error) {
        failures.push(
          `slice 2 --verbose smoke failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
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
