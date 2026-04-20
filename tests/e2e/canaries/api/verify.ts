import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function verify(workdir: string): Promise<{ passed: boolean; details: string }> {
  const checks: string[] = [];
  const failures: string[] = [];

  if (fs.existsSync(path.join(workdir, 'src', 'server.ts'))) {
    checks.push('src/server.ts exists');
  } else {
    failures.push('src/server.ts missing');
  }
  if (fs.existsSync(path.join(workdir, 'tests', 'server.test.ts'))) {
    checks.push('tests/server.test.ts exists');
  } else {
    failures.push('tests/server.test.ts missing');
  }

  // Build fallback if agent didn't run tsc
  const entryJs = path.join(workdir, 'dist', 'index.js');
  if (!fs.existsSync(entryJs)) {
    try {
      execSync('npx tsc', { cwd: workdir, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
    } catch (error) {
      failures.push(
        `tsc fallback failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
      );
    }
  }
  if (fs.existsSync(entryJs)) {
    checks.push('dist/index.js exists');
  } else {
    failures.push('dist/index.js missing after fallback build');
    return summarize(checks, failures);
  }

  // Boot the server on an ephemeral port and hit it.
  const port = 4300 + Math.floor(Math.random() * 500);
  const child = spawn('node', [entryJs], {
    cwd: workdir,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (c: Buffer) => {
    stderr += c.toString();
  });

  try {
    // Wait for listen. Poll up to 5 seconds.
    let ready = false;
    for (let i = 0; i < 25; i += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/notes`);
        if (res.ok || res.status === 404 || res.status === 405) {
          ready = true;
          break;
        }
      } catch {
        /* not ready yet */
      }
      await sleep(200);
    }

    if (!ready) {
      failures.push(
        `server did not start on port ${port} within 5s. stderr: ${stderr.slice(0, 300)}`,
      );
      return summarize(checks, failures);
    }

    // POST a note, assert 201 + id
    const postRes = await fetch(`http://127.0.0.1:${port}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello from verify' }),
    });
    if (postRes.status !== 201) {
      failures.push(`POST /notes returned ${postRes.status} (expected 201)`);
    } else {
      const body = (await postRes.json()) as { id?: string; text?: string };
      if (typeof body.id !== 'string' || body.id.length === 0) {
        failures.push('POST /notes response missing id');
      } else {
        checks.push(`POST created note id=${body.id.slice(0, 8)}...`);
        // GET by id
        const getRes = await fetch(`http://127.0.0.1:${port}/notes/${body.id}`);
        if (getRes.status !== 200) {
          failures.push(`GET /notes/:id returned ${getRes.status}`);
        } else {
          checks.push('GET /notes/:id returned 200');
        }
      }
    }

    // GET list
    const listRes = await fetch(`http://127.0.0.1:${port}/notes`);
    if (listRes.status !== 200) {
      failures.push(`GET /notes returned ${listRes.status}`);
    } else {
      const list = await listRes.json();
      if (!Array.isArray(list)) {
        failures.push('GET /notes did not return an array');
      } else {
        checks.push(`GET /notes returned ${list.length} notes`);
      }
    }
  } finally {
    child.kill('SIGTERM');
    await sleep(100);
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
