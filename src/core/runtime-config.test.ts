import {
  parseAgentModelConfig,
  resolveGatePair,
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
