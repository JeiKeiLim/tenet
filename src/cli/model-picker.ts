import spawn from 'cross-spawn';
import { promptText, selectFromList, type SelectOption } from './select.js';

/**
 * Per-adapter model enumeration and pickers.
 *
 * Enumeration rules (verified against live CLIs):
 * - claude-code has NO model-list command. Unrecognized words fall through to the
 *   positional PROMPT and start a billed session, so never probe it — use the
 *   static alias menu.
 * - codex lists models with `codex debug models` (JSON catalog). `codex models`
 *   is not a command and forwards to the interactive TUI.
 * - opencode lists `provider/model` lines with `opencode models`; the optional
 *   positional provider filter keeps the second step short.
 *
 * Every picker ends with a manual free-text escape entry (stored verbatim) so a
 * stale catalog or an unlisted model never traps the user.
 */

/** Adapter registry keys — the values stored in config.json (never "claude"). */
export const ADAPTER_KEYS = ['claude-code', 'opencode', 'codex'] as const;
export type AdapterKey = (typeof ADAPTER_KEYS)[number];

export const isAdapterKey = (value: string): value is AdapterKey =>
  (ADAPTER_KEYS as readonly string[]).includes(value);

export const adapterKeyOptions = (): SelectOption[] =>
  ADAPTER_KEYS.map((key) => ({ label: key, value: key }));

/**
 * Claude Code model aliases. There is no enumeration surface, so this list is
 * maintained by hand (full model IDs such as claude-opus-5-5 are also valid and
 * reachable through the custom entry).
 */
export const CLAUDE_MODEL_ALIASES = [
  'best',
  'fable',
  'sonnet',
  'opus',
  'haiku',
  'sonnet[1m]',
  'opus[1m]',
  'opusplan',
  'opusplan[1m]',
] as const;

export type CodexModelEntry = {
  slug: string;
  displayName?: string;
};

const UNSET_OPTION_LABEL = 'CLI default (unset)';
const CUSTOM_ENTRY_VALUE = '__custom__';
const CUSTOM_ENTRY_LABEL = 'Custom model name…';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readCommand = (command: string, args: string[]): string | null => {
  // cross-spawn resolves npm's .cmd shims on Windows, which plain
  // node:child_process execFileSync cannot execute.
  const result = spawn.sync(command, args, {
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    return null;
  }
  return result.stdout;
};

/** Parse the `codex debug models` catalog, keeping only pickable models. */
export const parseCodexModelCatalog = (raw: string): CodexModelEntry[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const list = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.models)
      ? parsed.models
      : [];

  const seen = new Set<string>();
  const entries: CodexModelEntry[] = [];
  for (const item of list) {
    if (!isRecord(item) || item.visibility !== 'list') {
      continue;
    }
    const slug = typeof item.slug === 'string' ? item.slug.trim() : '';
    if (slug.length === 0 || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    const displayName = typeof item.display_name === 'string' ? item.display_name.trim() : '';
    entries.push({ slug, displayName: displayName.length > 0 ? displayName : undefined });
  }
  return entries;
};

/** Parse `opencode models` output: one `provider/model` identifier per line. */
export const parseOpenCodeModelLines = (raw: string): string[] => {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.includes('/') && !line.startsWith('#'));
  return Array.from(new Set(lines));
};

/** Unique providers (sorted) from `provider/model` identifiers. */
export const openCodeProviders = (modelLines: string[]): string[] => {
  const providers = new Set<string>();
  for (const line of modelLines) {
    const [provider] = line.split('/');
    if (provider) {
      providers.add(provider);
    }
  }
  return Array.from(providers).sort();
};

const promptModelName = async (question: string): Promise<string | null> => {
  const answer = await promptText(question);
  if (answer === null) {
    return null;
  }
  const trimmed = answer.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/** Turn a widget result into the picker contract (null = cancelled). */
const resolvePicked = async (
  picked: string | null,
  customQuestion: string,
): Promise<string | null> => {
  if (picked === null) {
    return null;
  }
  if (picked === CUSTOM_ENTRY_VALUE) {
    return promptModelName(customQuestion);
  }
  return picked;
};

const withUnsetOption = (allowUnset: boolean, options: SelectOption[]): SelectOption[] =>
  allowUnset ? [{ label: UNSET_OPTION_LABEL, value: '' }, ...options] : options;

const customOption = (): SelectOption => ({ label: CUSTOM_ENTRY_LABEL, value: CUSTOM_ENTRY_VALUE });

export type ModelPickerOptions = {
  /**
   * Worker pickers allow "CLI default (unset)" (clears default_agent_model).
   * The adviser requires a real model, so its picker passes false.
   */
  allowUnset?: boolean;
  /** Currently configured model, highlighted when it appears in the list. */
  initialModel?: string;
  /** Widget title override (init asks "Model for <agent>?"). */
  title?: string;
};

const pickClaudeModel = async (options: ModelPickerOptions): Promise<string | null> => {
  const allowUnset = options.allowUnset === true;
  const initialValue = allowUnset && !options.initialModel ? '' : options.initialModel;
  const picked = await selectFromList(
    options.title ?? 'Claude Code model',
    withUnsetOption(
      allowUnset,
      [
        ...CLAUDE_MODEL_ALIASES.map((alias) => ({ label: alias, value: alias })),
        customOption(),
      ],
    ),
    { initialValue },
  );
  return resolvePicked(picked, 'Claude Code model name or alias: ');
};

const pickCodexModel = async (options: ModelPickerOptions): Promise<string | null> => {
  const allowUnset = options.allowUnset === true;
  const raw = readCommand('codex', ['debug', 'models']);
  const entries = raw === null ? [] : parseCodexModelCatalog(raw);

  if (entries.length === 0) {
    console.log(
      'Could not enumerate codex models (run `codex debug models` to check the CLI). Enter the model name manually.',
    );
    return promptModelName('Codex model name: ');
  }

  const initialValue = allowUnset && !options.initialModel ? '' : options.initialModel;
  const picked = await selectFromList(
    options.title ?? 'Codex model',
    withUnsetOption(allowUnset, [
      ...entries.map((entry) => ({
        label: entry.displayName && entry.displayName !== entry.slug
          ? `${entry.displayName} (${entry.slug})`
          : entry.slug,
        value: entry.slug,
      })),
      customOption(),
    ]),
    { initialValue },
  );
  return resolvePicked(picked, 'Codex model name: ');
};

const pickOpenCodeModel = async (options: ModelPickerOptions): Promise<string | null> => {
  const allowUnset = options.allowUnset === true;
  const raw = readCommand('opencode', ['models']);
  const allLines = raw === null ? [] : parseOpenCodeModelLines(raw);

  if (allLines.length === 0) {
    console.log(
      'Could not enumerate opencode models (`opencode models` failed or returned nothing). Enter the model name manually.',
    );
    return promptModelName('OpenCode model name (provider/model): ');
  }

  const providers = openCodeProviders(allLines);
  const configuredProvider = options.initialModel?.includes('/')
    ? options.initialModel.split('/')[0]
    : undefined;
  const provider = await selectFromList(
    'OpenCode provider',
    providers.map((name) => ({ label: name, value: name })),
    { initialValue: configuredProvider },
  );
  if (provider === null) {
    return null;
  }

  const providerRaw = readCommand('opencode', ['models', provider]);
  let modelLines = providerRaw === null
    ? []
    : parseOpenCodeModelLines(providerRaw).filter((line) => line.startsWith(`${provider}/`));
  if (modelLines.length === 0) {
    // Fall back to the full listing already in hand before asking for manual input.
    modelLines = allLines.filter((line) => line.startsWith(`${provider}/`));
  }
  if (modelLines.length === 0) {
    console.log(`Could not enumerate models for provider "${provider}". Enter the model name manually.`);
    return promptModelName('OpenCode model name (provider/model): ');
  }

  const initialValue = allowUnset && !options.initialModel ? '' : options.initialModel;
  const picked = await selectFromList(
    options.title ?? `OpenCode model (${provider})`,
    withUnsetOption(allowUnset, [
      ...modelLines.map((line) => ({
        label: line.slice(provider.length + 1),
        value: line,
      })),
      customOption(),
    ]),
    { initialValue },
  );
  return resolvePicked(picked, 'OpenCode model name (provider/model): ');
};

/**
 * Pick a model for an adapter. Resolves the model string verbatim, "" for the
 * worker's "CLI default (unset)" choice, or null when the user cancels.
 */
export const pickModelForAgent = async (
  agent: AdapterKey,
  options: ModelPickerOptions = {},
): Promise<string | null> => {
  switch (agent) {
    case 'claude-code':
      return pickClaudeModel(options);
    case 'codex':
      return pickCodexModel(options);
    case 'opencode':
      return pickOpenCodeModel(options);
    default:
      return null;
  }
};

export type AdviserSelection = {
  agent: AdapterKey;
  model: string;
};

/**
 * An agent+model pair is one logical unit (the model menu depends on the agent),
 * so the pickers are chained and return both values together. Cancel at either
 * step cancels the whole flow — callers must not write a partial pair.
 *
 * Used by the adviser flow and the validator-gate config menu (clarity /
 * readiness). No unsets: every pair consumer requires a real model.
 */
export const pickAgentPair = async (
  title: string,
  current: { agent?: string; model?: string } = {},
): Promise<AdviserSelection | null> => {
  const agent = await selectFromList(title, adapterKeyOptions(), {
    initialValue: current.agent !== undefined && isAdapterKey(current.agent)
      ? current.agent
      : undefined,
  });
  if (agent === null || !isAdapterKey(agent)) {
    return null;
  }

  // No unsets: a pair consumer requires a real model (both keys must be set).
  const model = await pickModelForAgent(agent, {
    allowUnset: false,
    // A model configured for a different adapter would not match anything here.
    initialModel: current.agent === agent ? current.model : undefined,
  });
  if (model === null || model.length === 0) {
    return null;
  }
  return { agent, model };
};

/** Adviser pair picker — pickAgentPair with the adviser's agent-picker title. */
export const pickAdviserConfig = async (
  current: { agent?: string; model?: string } = {},
): Promise<AdviserSelection | null> => pickAgentPair('Adviser agent', current);
