import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildDispatchConfigSnapshot,
  createLiveStateConfigReader,
  parseAgentModelConfig,
  resolveGatePair,
  stateConfigFilePath,
  type AdviserConfig,
  type GateValidatorsConfig,
} from './runtime-config.js';

const adviser: AdviserConfig = { agent: 'claude-code', model: 'opus' };

describe('parseAgentModelConfig validator gates', () => {
  it('reads both gate pairs when all four keys are set', () => {
    expect(
      parseAgentModelConfig({
        clarity_agent: 'claude-code',
        clarity_model: 'opus',
        readiness_agent: 'codex',
        readiness_model: 'gpt-6-astra',
      }).gateValidators,
    ).toEqual({
      clarity: { agent: 'claude-code', model: 'opus' },
      readiness: { agent: 'codex', model: 'gpt-6-astra' },
    });
  });

  it('omits gateValidators entirely when no gate key is set', () => {
    expect(parseAgentModelConfig({}).gateValidators).toBeUndefined();
    expect(parseAgentModelConfig({ default_agent_model: 'sonnet' }).gateValidators).toBeUndefined();
  });

  it('collapses each gate independently: a partial pair is unset, the complete sibling stays', () => {
    expect(
      parseAgentModelConfig({
        clarity_agent: 'claude-code',
        readiness_agent: 'codex',
        readiness_model: 'gpt-6-astra',
      }).gateValidators,
    ).toEqual({
      clarity: undefined,
      readiness: { agent: 'codex', model: 'gpt-6-astra' },
    });
  });

  it('treats whitespace-only values and non-strings as unset', () => {
    expect(
      parseAgentModelConfig({
        clarity_agent: '  ',
        clarity_model: 'opus',
        readiness_agent: 'codex',
        readiness_model: '   ',
      }).gateValidators,
    ).toBeUndefined();
    expect(
      parseAgentModelConfig({ clarity_agent: 42, clarity_model: 'opus' }).gateValidators,
    ).toBeUndefined();
  });

  it('keeps the adviser and defaultAgentModel surfaces unchanged alongside the gates', () => {
    const parsed = parseAgentModelConfig({
      adviser_agent: 'codex',
      adviser_model: 'gpt-6-astra',
      default_agent_model: 'sonnet',
      clarity_agent: 'claude-code',
      clarity_model: 'opus',
    });
    expect(parsed.adviser).toEqual({ agent: 'codex', model: 'gpt-6-astra' });
    expect(parsed.defaultAgentModel).toBe('sonnet');
    expect(parsed.gateValidators).toEqual({ clarity: { agent: 'claude-code', model: 'opus' } });
  });
});

describe('resolveGatePair fallback chain', () => {
  it('returns the gate own pair first', () => {
    const gates: GateValidatorsConfig = {
      clarity: { agent: 'claude-code', model: 'opus' },
      readiness: { agent: 'codex', model: 'gpt-6-astra' },
    };
    expect(resolveGatePair(gates, adviser, 'clarity')).toEqual({ agent: 'claude-code', model: 'opus' });
    expect(resolveGatePair(gates, adviser, 'readiness')).toEqual({ agent: 'codex', model: 'gpt-6-astra' });
  });

  it('falls back to the sibling gate pair, symmetrically', () => {
    const gates: GateValidatorsConfig = { readiness: { agent: 'codex', model: 'gpt-6-astra' } };
    expect(resolveGatePair(gates, adviser, 'clarity')).toEqual({ agent: 'codex', model: 'gpt-6-astra' });

    const clarityOnly: GateValidatorsConfig = { clarity: { agent: 'claude-code', model: 'opus' } };
    expect(resolveGatePair(clarityOnly, adviser, 'readiness')).toEqual({ agent: 'claude-code', model: 'opus' });
  });

  it('falls back to the adviser pair when no gate pair is configured', () => {
    expect(resolveGatePair(undefined, adviser, 'clarity')).toBe(adviser);
    expect(resolveGatePair({}, adviser, 'readiness')).toBe(adviser);
  });

  it('returns undefined when no tier resolves (today eval path takes over)', () => {
    expect(resolveGatePair(undefined, undefined, 'clarity')).toBeUndefined();
    expect(resolveGatePair({}, undefined, 'readiness')).toBeUndefined();
  });
});

describe('createLiveStateConfigReader (per-dispatch reads, keep-last-good)', () => {
  const tempDirs: string[] = [];
  const writeConfig = (dir: string, content: string): void => {
    fs.writeFileSync(stateConfigFilePath(dir), content, 'utf8');
  };

  afterEach(() => {
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
    }
  });

  it('reads the current file contents on every call (no caching)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-reader-test-'));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, '.tenet', '.state'), { recursive: true });
    const read = createLiveStateConfigReader(stateConfigFilePath(dir));

    // Missing file before any successful read: fresh-project {} — never throws.
    expect(read()).toEqual({});

    writeConfig(dir, JSON.stringify({ default_agent: 'codex' }));
    expect(read()).toEqual({ default_agent: 'codex' });

    writeConfig(dir, JSON.stringify({ default_agent: 'opencode', max_retries: 2 }));
    expect(read()).toEqual({ default_agent: 'opencode', max_retries: 2 });
  });

  it('keeps the last good object on a malformed file (torn mid-write read)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-reader-test-'));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, '.tenet', '.state'), { recursive: true });
    const read = createLiveStateConfigReader(stateConfigFilePath(dir));

    writeConfig(dir, JSON.stringify({ default_agent: 'codex', adviser_model: 'opus' }));
    expect(read()).toEqual({ default_agent: 'codex', adviser_model: 'opus' });

    // A torn read (half-written JSON) must degrade to the last good snapshot,
    // never to {} — {} would silently reset dispatch to defaults mid-run.
    writeConfig(dir, '{ "default_agent": "cod');
    expect(read()).toEqual({ default_agent: 'codex', adviser_model: 'opus' });

    // Recovery on the next parse.
    writeConfig(dir, JSON.stringify({ default_agent: 'opencode' }));
    expect(read()).toEqual({ default_agent: 'opencode' });
  });

  it('keeps the last good object after the file is deleted (ENOENT after seen)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-reader-test-'));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, '.tenet', '.state'), { recursive: true });
    const configPath = stateConfigFilePath(dir);
    const read = createLiveStateConfigReader(configPath);

    writeConfig(dir, JSON.stringify({ default_agent: 'codex' }));
    expect(read()).toEqual({ default_agent: 'codex' });

    fs.rmSync(configPath);
    expect(read()).toEqual({ default_agent: 'codex' });
  });

  it('treats valid non-object JSON as malformed (keep last good, never serve it)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-reader-test-'));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, '.tenet', '.state'), { recursive: true });
    const configPath = stateConfigFilePath(dir);
    const read = createLiveStateConfigReader(configPath);

    writeConfig(dir, JSON.stringify({ default_agent: 'codex' }));
    expect(read()).toEqual({ default_agent: 'codex' }); // establish the last-good object
    for (const malformed of ['[]', 'null', '"a string"', '42', '']) {
      writeConfig(dir, malformed);
      expect(read()).toEqual({ default_agent: 'codex' });
    }
  });
});

describe('buildDispatchConfigSnapshot', () => {
  it('parses every dispatch surface from one raw object', () => {
    const snapshot = buildDispatchConfigSnapshot({
      default_agent: ' codex ',
      default_agent_model: 'sonnet',
      adviser_agent: 'claude-code',
      adviser_model: 'opus',
      clarity_agent: 'claude-code',
      clarity_model: 'opus',
      max_retries: '5',
      timeout_minutes: 90,
    });

    expect(snapshot.raw).toMatchObject({ default_agent: ' codex ' });
    expect(snapshot.defaultAgent).toBe('codex'); // trimmed
    expect(snapshot.pairs.adviser).toEqual({ agent: 'claude-code', model: 'opus' });
    expect(snapshot.pairs.defaultAgentModel).toBe('sonnet');
    expect(snapshot.pairs.gateValidators).toEqual({ clarity: { agent: 'claude-code', model: 'opus' } });
    expect(snapshot.maxRetries).toBe(5);
    expect(snapshot.timeoutMinutes).toBe(90);
  });

  it('defaults scalars exactly like the legacy per-key parses', () => {
    const snapshot = buildDispatchConfigSnapshot({});
    expect(snapshot.defaultAgent).toBeUndefined();
    expect(snapshot.maxRetries).toBe(-1); // UNLIMITED_RETRIES — parseMaxRetries default
    expect(snapshot.timeoutMinutes).toBeNull(); // parseTimeoutMinutes default
    expect(snapshot.pairs).toEqual({ adviser: undefined, defaultAgentModel: undefined, gateValidators: undefined });
  });

  it('reads non-string/non-number scalars as unset rather than parsing garbage', () => {
    const snapshot = buildDispatchConfigSnapshot({
      max_retries: { bogus: true },
      timeout_minutes: ['90'],
    });
    expect(snapshot.maxRetries).toBe(-1);
    expect(snapshot.timeoutMinutes).toBeNull();
  });
});
