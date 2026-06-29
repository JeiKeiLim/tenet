import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import type { Job } from '../types/index.js';
import { writeStatusFiles, compareJobsByPlan } from './status-writer.js';

const tempDirs: string[] = [];

const makeProject = (): string => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-status-writer-test-'));
  fs.mkdirSync(path.join(tempDir, '.tenet', 'spec'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, '.tenet', 'status'), { recursive: true });
  tempDirs.push(tempDir);
  return tempDir;
};

const writeSpec = (projectPath: string, filename: string, content: string): void => {
  fs.writeFileSync(path.join(projectPath, '.tenet', 'spec', filename), content, 'utf8');
};

const readStatusMd = (projectPath: string): string =>
  fs.readFileSync(path.join(projectPath, '.tenet', 'status', 'status.md'), 'utf8');

const job = (overrides: Partial<Job> & { id: string; dagId?: string; status: Job['status'] }): Job => {
  const { dagId, ...rest } = overrides;
  return {
    type: 'dev',
    name: '',
    params: { dag_id: dagId ?? overrides.id, name: dagId ?? overrides.id },
    agentName: 'default',
    retryCount: 0,
    maxRetries: 3,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    serverId: '',
    ...rest,
  } as Job;
};

const summary = (jobs: Job[]): Parameters<typeof writeStatusFiles>[1] => ({
  jobs,
  completed: jobs.filter((j) => j.status === 'completed').length,
  total: jobs.length,
  running: jobs.filter((j) => j.status === 'running'),
  failed: jobs.filter((j) => j.status === 'failed'),
  pending: jobs.filter((j) => j.status === 'pending'),
  blocked: jobs.filter((j) => j.status === 'blocked'),
});

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('compareJobsByPlan (#23)', () => {
  const j = (dagId: string | undefined, createdAt: number): Job =>
    ({
      id: dagId ?? 'adhoc',
      type: 'dev',
      status: 'pending',
      params: dagId ? { dag_id: dagId, name: dagId } : { name: 'adhoc' },
      agentName: 'default',
      retryCount: 0,
      maxRetries: 3,
      createdAt,
      updatedAt: createdAt,
      serverId: '',
    }) as Job;

  it('orders dag_ids numerically (10 after 2), not lexically', () => {
    const jobs = [j('s-10', 3), j('s-2', 1), j('s-1', 2)].sort(compareJobsByPlan);
    expect(jobs.map((x) => x.params.dag_id)).toEqual(['s-1', 's-2', 's-10']);
  });

  it('falls back to created_at when dag_id is absent (ad-hoc jobs)', () => {
    const jobs = [j(undefined, 30), j(undefined, 10), j(undefined, 20)].sort(compareJobsByPlan);
    expect(jobs.map((x) => x.createdAt)).toEqual([10, 20, 30]);
  });

  it('places dag_id jobs before ad-hoc jobs', () => {
    const jobs = [j(undefined, 1), j('a-1', 5)].sort(compareJobsByPlan);
    expect(jobs.map((x) => x.params.dag_id)).toEqual(['a-1', undefined]);
  });
});

describe('status-writer slice progress (agile mode)', () => {
  const SPEC_AGILE = `---
delivery_mode: agile
---

# Test feature

## Slice plan

Total slices: 3

### Slice 1: login + signup
- Adds: auth
- Bundled with: signup
- User can: sign up and log in
- Out of slice: posts

### Slice 2: posting
- Adds: post creation
- User can: write and view posts

### Slice 3: friends
- Adds: friend connections
- User can: follow other users
`;

  const SPEC_AUTONOMOUS = `---
delivery_mode: autonomous
---

# Autonomous feature
`;

  const SPEC_NO_FRONTMATTER = `# Old-style spec without frontmatter\n`;

  it('AC16: surfaces slice-level line when delivery_mode=agile and jobs are slice-tagged', () => {
    const projectPath = makeProject();
    writeSpec(projectPath, '2026-04-29-sns.md', SPEC_AGILE);

    writeStatusFiles(
      projectPath,
      summary([
        job({ id: 'j1', dagId: 'slice-1-auth-api', status: 'completed' }),
        job({ id: 'j2', dagId: 'slice-1-login-ui', status: 'completed' }),
        job({ id: 'j3', dagId: 'slice-1-e2e', status: 'completed' }),
        job({ id: 'j4', dagId: 'slice-2-posts-api', status: 'running' }),
        job({ id: 'j5', dagId: 'slice-2-posts-ui', status: 'pending' }),
      ]),
    );

    const content = readStatusMd(projectPath);
    expect(content).toContain('Slice 2 of 3 in progress: posting');
    // Slice line appears above the metric table
    expect(content.indexOf('Slice 2 of 3')).toBeLessThan(content.indexOf('| Metric '));
  });

  it('AC17: derives slice progress from spec slice plan + job state', () => {
    const projectPath = makeProject();
    writeSpec(projectPath, '2026-04-29-sns.md', SPEC_AGILE);

    // All slice-1 jobs running, no slice-2 jobs yet.
    writeStatusFiles(
      projectPath,
      summary([
        job({ id: 'j1', dagId: 'slice-1-auth-api', status: 'running' }),
        job({ id: 'j2', dagId: 'slice-1-login-ui', status: 'pending' }),
      ]),
    );

    expect(readStatusMd(projectPath)).toContain('Slice 1 of 3 in progress: login + signup');
  });

  it('AC18: status.md output is unchanged when delivery_mode=autonomous', () => {
    const projectPath = makeProject();
    writeSpec(projectPath, '2026-04-29-classic.md', SPEC_AUTONOMOUS);

    writeStatusFiles(
      projectPath,
      summary([
        job({ id: 'j1', dagId: 'slice-1-foo', status: 'running' }), // even slice-prefixed jobs ignored in autonomous mode
      ]),
    );

    expect(readStatusMd(projectPath)).not.toContain('Slice ');
    expect(readStatusMd(projectPath)).not.toContain(' in progress: ');
  });

  it('AC18: status.md unchanged when no spec file exists', () => {
    const projectPath = makeProject();
    // No spec written.

    writeStatusFiles(
      projectPath,
      summary([job({ id: 'j1', dagId: 'slice-1-foo', status: 'running' })]),
    );

    expect(readStatusMd(projectPath)).not.toContain('Slice ');
  });

  it('AC18: status.md unchanged when spec has no frontmatter (legacy spec)', () => {
    const projectPath = makeProject();
    writeSpec(projectPath, '2026-04-29-legacy.md', SPEC_NO_FRONTMATTER);

    writeStatusFiles(
      projectPath,
      summary([job({ id: 'j1', dagId: 'slice-1-foo', status: 'running' })]),
    );

    expect(readStatusMd(projectPath)).not.toContain('Slice ');
  });

  it('falls back gracefully when agile spec has slice-tagged jobs but no Slice plan section', () => {
    const projectPath = makeProject();
    writeSpec(projectPath, '2026-04-29-broken.md', `---\ndelivery_mode: agile\n---\n\n# No slice plan section`);

    writeStatusFiles(
      projectPath,
      summary([job({ id: 'j1', dagId: 'slice-1-foo', status: 'running' })]),
    );

    // No slice progress line since slice plan can't be parsed.
    expect(readStatusMd(projectPath)).not.toContain(' in progress: ');
  });

  it('does not emit slice line when jobs do not follow slice-N convention', () => {
    const projectPath = makeProject();
    writeSpec(projectPath, '2026-04-29-sns.md', SPEC_AGILE);

    writeStatusFiles(
      projectPath,
      summary([
        job({ id: 'j1', dagId: 'auth-api', status: 'running' }),
        job({ id: 'j2', dagId: 'login-ui', status: 'pending' }),
      ]),
    );

    expect(readStatusMd(projectPath)).not.toContain(' in progress: ');
  });
});
