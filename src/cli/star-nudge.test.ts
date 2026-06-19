import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { maybeStarNudge } from './star-nudge.js';
import { readStateConfig } from './init.js';

const tempDirs: string[] = [];
let prevNoNudge: string | undefined;

const createProject = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-star-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, '.tenet', '.state'), { recursive: true });
  return dir;
};

const starredAt = (projectPath: string): string | undefined =>
  readStateConfig(path.join(projectPath, '.tenet')).star_nudge?.starredAt;

beforeEach(() => {
  prevNoNudge = process.env.TENET_NO_STAR_NUDGE;
  delete process.env.TENET_NO_STAR_NUDGE;
});

afterEach(() => {
  if (prevNoNudge === undefined) {
    delete process.env.TENET_NO_STAR_NUDGE;
  } else {
    process.env.TENET_NO_STAR_NUDGE = prevNoNudge;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('maybeStarNudge', () => {
  it('is a no-op when TENET_NO_STAR_NUDGE is set (no prompt, no state)', async () => {
    process.env.TENET_NO_STAR_NUDGE = '1';
    const projectPath = createProject();
    const ghCheck = vi.fn(() => true);
    const prompt = vi.fn(async () => true);
    await maybeStarNudge(projectPath, { isTty: true, ghCheck, prompt, now: () => 't0' });
    expect(ghCheck).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(starredAt(projectPath)).toBeUndefined();
  });

  it('returns without writing state when non-interactive', async () => {
    const projectPath = createProject();
    const ghCheck = vi.fn(() => null);
    const prompt = vi.fn(async () => true);
    await maybeStarNudge(projectPath, { isTty: false, ghCheck, prompt, now: () => 't0' });
    expect(ghCheck).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(starredAt(projectPath)).toBeUndefined();
  });

  it('records starredAt silently and never prompts when gh confirms starred', async () => {
    const projectPath = createProject();
    const ghCheck = vi.fn(() => true);
    const prompt = vi.fn(async () => true);
    await maybeStarNudge(projectPath, { isTty: true, ghCheck, prompt, now: () => 't0' });
    expect(prompt).not.toHaveBeenCalled();
    expect(starredAt(projectPath)).toBe('t0');
  });

  it('a decline ("no") writes nothing so it asks again next time', async () => {
    const projectPath = createProject();
    const ghCheck = vi.fn(() => false);
    const prompt = vi.fn(async () => false);
    await maybeStarNudge(projectPath, { isTty: true, ghCheck, prompt, now: () => 't0' });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(starredAt(projectPath)).toBeUndefined();

    // Second interactive run re-asks — a decline is "not now", not "never".
    await maybeStarNudge(projectPath, { isTty: true, ghCheck, prompt, now: () => 't1' });
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('records starredAt when the user accepts and the star succeeds', async () => {
    const projectPath = createProject();
    const ghCheck = vi.fn(() => false);
    const prompt = vi.fn(async () => true);
    const star = vi.fn(() => true);
    await maybeStarNudge(projectPath, { isTty: true, ghCheck, star, prompt, now: () => 't0' });
    expect(star).toHaveBeenCalledTimes(1);
    expect(starredAt(projectPath)).toBe('t0');
  });

  it('writes nothing when the user accepts but the star PUT fails (re-asks)', async () => {
    const projectPath = createProject();
    const ghCheck = vi.fn(() => false);
    const prompt = vi.fn(async () => true);
    const star = vi.fn(() => false);
    await maybeStarNudge(projectPath, { isTty: true, ghCheck, star, prompt, now: () => 't0' });
    expect(starredAt(projectPath)).toBeUndefined();
  });

  it('does not prompt once starredAt is recorded', async () => {
    const projectPath = createProject();
    const ghCheck = vi.fn(() => false);
    const prompt = vi.fn(async () => true);
    const star = vi.fn(() => true);
    await maybeStarNudge(projectPath, { isTty: true, ghCheck, star, prompt, now: () => 't0' });
    expect(prompt).toHaveBeenCalledTimes(1);

    // Subsequent run sees starredAt and stays silent (ghCheck not even called).
    ghCheck.mockClear();
    prompt.mockClear();
    await maybeStarNudge(projectPath, { isTty: true, ghCheck, prompt, now: () => 't1' });
    expect(ghCheck).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });

  it('treats a throwing ghCheck as "cannot tell" and still asks', async () => {
    const projectPath = createProject();
    const ghCheck = vi.fn(() => {
      throw new Error('boom');
    });
    const prompt = vi.fn(async () => false);
    await maybeStarNudge(projectPath, { isTty: true, ghCheck, prompt, now: () => 't0' });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(starredAt(projectPath)).toBeUndefined();
  });

  it('preserves existing config fields when writing starredAt', async () => {
    const projectPath = createProject();
    const tenetRoot = path.join(projectPath, '.tenet');
    fs.writeFileSync(
      path.join(tenetRoot, '.state', 'config.json'),
      JSON.stringify({ default_agent: 'codex' }),
      'utf8',
    );
    await maybeStarNudge(projectPath, {
      isTty: true,
      ghCheck: () => true,
      prompt: vi.fn(async () => true),
      now: () => 't0',
    });
    const config = readStateConfig(tenetRoot);
    expect(config.default_agent).toBe('codex');
    expect(config.star_nudge?.starredAt).toBe('t0');
  });
});
