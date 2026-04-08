import type { AgentAdapter, AgentInvocation, AgentResponse } from './base.js';
import { AdapterRegistry } from './index.js';

class MockAdapter implements AgentAdapter {
  public readonly name: string;
  private readonly available: boolean;

  constructor(name: string, available: boolean) {
    this.name = name;
    this.available = available;
  }

  async invoke(_invocation: AgentInvocation): Promise<AgentResponse> {
    return {
      success: true,
      output: 'ok',
      durationMs: 0,
    };
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }
}

const createEmptyRegistry = (): AdapterRegistry => {
  const registry = new AdapterRegistry();
  const holder = registry as unknown as { adapters: Map<string, AgentAdapter> };
  holder.adapters.clear();
  return registry;
};

describe('AdapterRegistry', () => {
  it('registers adapter and retrieves by name', () => {
    const registry = createEmptyRegistry();
    const adapter = new MockAdapter('mock-1', true);

    registry.register(adapter);

    expect(registry.get('mock-1')).toBe(adapter);
  });

  it('lists all adapters with availability status', async () => {
    const registry = createEmptyRegistry();
    registry.register(new MockAdapter('available-adapter', true));
    registry.register(new MockAdapter('unavailable-adapter', false));

    const available = await registry.listAvailable();
    expect(available).toEqual([
      { name: 'available-adapter', available: true },
      { name: 'unavailable-adapter', available: false },
    ]);
  });

  it('returns first available adapter as default', async () => {
    const registry = createEmptyRegistry();
    registry.register(new MockAdapter('first-unavailable', false));
    const second = new MockAdapter('second-available', true);
    registry.register(second);
    registry.register(new MockAdapter('third-available', true));

    const selected = await registry.getDefault();
    expect(selected).toBe(second);
  });

  it('throws when no adapters are available for default selection', async () => {
    const registry = createEmptyRegistry();
    registry.register(new MockAdapter('none-1', false));
    registry.register(new MockAdapter('none-2', false));

    await expect(registry.getDefault()).rejects.toThrowError(/no available adapters/);
  });
});
