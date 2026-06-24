import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCriticRoster, resolveRoster, DEFAULT_ROSTER, type ResolvedCritic } from './critic-roster.js';

const byId = (critics: ResolvedCritic[], id: string): ResolvedCritic | undefined =>
  critics.find((c) => c.id === id);

describe('resolveRoster', () => {
  it('falls back to the 3 built-ins for invalid payloads', () => {
    expect(resolveRoster(null).map((c) => c.id)).toEqual(['code_critic', 'test_critic', 'playwright_eval']);
    expect(resolveRoster(undefined).map((c) => c.id)).toEqual(['code_critic', 'test_critic', 'playwright_eval']);
    expect(resolveRoster('nope').map((c) => c.id)).toEqual(['code_critic', 'test_critic', 'playwright_eval']);
    expect(resolveRoster({}).map((c) => c.id)).toEqual(['code_critic', 'test_critic', 'playwright_eval']);
    expect(resolveRoster({ critics: 'not-an-array' }).map((c) => c.id)).toEqual([
      'code_critic',
      'test_critic',
      'playwright_eval',
    ]);
  });

  it('resolves the 3 built-ins enabled by default', () => {
    const roster = resolveRoster({ version: 1, critics: [] });
    expect(roster).toHaveLength(3);
    expect(roster.every((c) => c.builtin && c.enabled)).toBe(true);
    expect(roster.map((c) => c.stage)).toEqual(['code_critic', 'test_critic', 'playwright_eval']);
    expect(roster.map((c) => c.jobType)).toEqual(['critic_eval', 'eval', 'playwright_eval']);
  });

  it('honors enabled:false on a built-in', () => {
    const roster = resolveRoster({
      critics: [{ id: 'playwright_eval', builtin: true, enabled: false }],
    });
    expect(byId(roster, 'playwright_eval')?.enabled).toBe(false);
    expect(byId(roster, 'code_critic')?.enabled).toBe(true);
  });

  it('appends built-ins omitted from an otherwise-valid file', () => {
    const roster = resolveRoster({
      critics: [{ id: 'code_critic', builtin: true, enabled: true }],
    });
    expect(roster.map((c) => c.id)).toEqual(['code_critic', 'test_critic', 'playwright_eval']);
  });

  it('resolves a custom critic with explicit stage/job_type/prompt_file', () => {
    const roster = resolveRoster({
      critics: [
        { id: 'code_critic', builtin: true, enabled: true },
        { id: 'test_critic', builtin: true, enabled: true },
        { id: 'playwright_eval', builtin: true, enabled: true },
        {
          id: 'security',
          builtin: false,
          enabled: true,
          stage: 'security_critic',
          job_type: 'critic_eval',
          prompt_file: '.tenet/critics/security.md',
        },
      ],
    });
    const sec = byId(roster, 'security');
    expect(sec).toEqual({
      id: 'security',
      builtin: false,
      enabled: true,
      stage: 'security_critic',
      jobType: 'critic_eval',
      promptFile: '.tenet/critics/security.md',
    });
  });

  it('defaults a custom critic stage to its id and job_type to critic_eval', () => {
    const roster = resolveRoster({ critics: [{ id: 'lint', prompt_file: '.tenet/critics/lint.md' }] });
    const lint = byId(roster, 'lint');
    expect(lint?.stage).toBe('lint');
    expect(lint?.jobType).toBe('critic_eval');
    expect(lint?.promptFile).toBe('.tenet/critics/lint.md');
  });

  it('rejects an invalid custom job_type, falling back to critic_eval', () => {
    const roster = resolveRoster({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      critics: [{ id: 'x', job_type: 'dev' as any, prompt_file: '.tenet/critics/x.md' }],
    });
    expect(byId(roster, 'x')?.jobType).toBe('critic_eval');
  });

  it('drops duplicate ids (first wins) and skips malformed entries', () => {
    const roster = resolveRoster({
      critics: [
        { id: 'code_critic', builtin: true, enabled: false },
        { id: 'code_critic', builtin: true, enabled: true }, // dup → dropped
        { builtin: true }, // no id → skipped
        { id: '', builtin: true }, // empty id → skipped
        'not-an-object',
      ],
    });
    const codeCritics = roster.filter((c) => c.id === 'code_critic');
    expect(codeCritics).toHaveLength(1);
    expect(codeCritics[0].enabled).toBe(false); // first wins
    expect(roster.map((c) => c.id)).toEqual(['code_critic', 'test_critic', 'playwright_eval']);
  });

  it('DEFAULT_ROSTER is the 3 built-ins enabled', () => {
    expect(DEFAULT_ROSTER.map((c) => c.id)).toEqual(['code_critic', 'test_critic', 'playwright_eval']);
    expect(DEFAULT_ROSTER.every((c) => c.enabled)).toBe(true);
  });
});

describe('loadCriticRoster', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-roster-test-'));

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns defaults when no roster file exists', () => {
    const { critics, warning } = loadCriticRoster(tmp);
    expect(warning).toBeUndefined();
    expect(critics.map((c) => c.id)).toEqual(['code_critic', 'test_critic', 'playwright_eval']);
  });

  it('returns defaults + a warning when the roster file is invalid JSON', () => {
    const rosterPath = path.join(mkdirTenet(tmp), 'critics.json');
    fs.writeFileSync(rosterPath, '{ broken', 'utf8');
    const { critics, warning } = loadCriticRoster(tmp);
    expect(critics.map((c) => c.id)).toEqual(['code_critic', 'test_critic', 'playwright_eval']);
    expect(warning).toEqual(expect.stringContaining('Could not parse'));
  });

  it('reads and resolves a valid roster file', () => {
    const rosterPath = path.join(mkdirTenet(tmp), 'critics.json');
    fs.writeFileSync(
      rosterPath,
      JSON.stringify({
        version: 1,
        critics: [
          { id: 'code_critic', builtin: true, enabled: true },
          { id: 'test_critic', builtin: true, enabled: true },
          { id: 'playwright_eval', builtin: true, enabled: false },
          { id: 'a11y', stage: 'a11y_critic', prompt_file: '.tenet/critics/a11y.md' },
        ],
      }),
      'utf8',
    );
    const { critics, warning } = loadCriticRoster(tmp);
    expect(warning).toBeUndefined();
    expect(byId(critics, 'playwright_eval')?.enabled).toBe(false);
    expect(byId(critics, 'a11y')?.stage).toBe('a11y_critic');
  });
});

/** Ensure `.tenet` exists under the temp project root; return its path. */
function mkdirTenet(projectPath: string): string {
  const tenet = path.join(projectPath, '.tenet');
  fs.mkdirSync(tenet, { recursive: true });
  return tenet;
}
