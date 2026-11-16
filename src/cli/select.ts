import readline from 'node:readline';

/**
 * Shared selector widget for every choice list in the init/config flow.
 *
 * Off-the-shelf selectors (@clack/prompts, inquirer) commit immediately on number
 * keys, which defeats the required "type a number, verify the highlight, then
 * press Enter" behavior. This is a deliberately small raw-mode implementation:
 * arrows move the highlight, number keys only MOVE it, Enter commits, Esc/q
 * cancels. Callers write config only after Enter returns a value.
 */

export type SelectOption = {
  label: string;
  value: string;
};

export type SelectOptions = {
  /** Value to highlight initially (e.g. the currently configured one). */
  initialValue?: string;
  /** Rows visible at once; longer lists scroll inside the widget. */
  windowSize?: number;
};

const DEFAULT_WINDOW_SIZE = 10;
const HIGHLIGHT_MARKER = '❯';
const HINT = '  ↑/↓ move · number jumps · Enter selects · Esc/q cancels';
const DIGIT_BUFFER_RESET_MS = 700;

/**
 * Keep every rendered line to one terminal row: a wrapped line would make the
 * cursor-up redraw count wrong and leave stale rows behind on long labels
 * (adapter-args values can be long).
 */
const fitLine = (line: string): string => {
  const columns = process.stdout.columns ?? 80;
  if (columns <= 1 || line.length < columns) {
    return line;
  }
  return `${line.slice(0, columns - 1)}…`;
};

/**
 * Ask the user to pick one option. Resolves the chosen option's value, or null
 * when cancelled (Esc, q, Ctrl-C) or when there is no interactive TTY.
 *
 * The widget restores cooked mode on every exit path and leaves no partial
 * writes behind — it only reads input and renders.
 */
export const selectFromList = (
  title: string,
  options: SelectOption[],
  config: SelectOptions = {},
): Promise<string | null> => {
  if (options.length === 0) {
    return Promise.resolve(null);
  }

  const input = process.stdin;
  // Raw mode needs a real terminal; in CI/piped runs there is nothing to drive.
  // Callers treat null as "no change", so this degrades safely.
  if (!input.isTTY || !process.stdout.isTTY) {
    return Promise.resolve(null);
  }

  const windowSize = Math.max(1, Math.min(config.windowSize ?? DEFAULT_WINDOW_SIZE, options.length));
  const maxOffset = Math.max(0, options.length - windowSize);

  const initialIndex = config.initialValue === undefined
    ? -1
    : options.findIndex((option) => option.value === config.initialValue);

  let highlight = Math.max(0, initialIndex);
  let offset = Math.min(Math.max(0, highlight - windowSize + 1), maxOffset);
  let renderedLines = 0;
  let digitBuffer = '';
  let digitTimer: NodeJS.Timeout | undefined;

  return new Promise((resolve) => {
    const eraseRendered = (): void => {
      if (!process.stdout.isTTY) {
        return;
      }
      if (renderedLines > 0) {
        process.stdout.write(`\x1b[${renderedLines}A\x1b[0J`);
        renderedLines = 0;
      }
    };

    const render = (): void => {
      eraseRendered();
      const visible = options.slice(offset, offset + windowSize);
      const lines: string[] = [fitLine(title)];
      visible.forEach((option, index) => {
        const marker = offset + index === highlight ? HIGHLIGHT_MARKER : ' ';
        lines.push(fitLine(`  ${marker} ${index + 1}) ${option.label}`));
      });
      if (options.length > windowSize) {
        lines.push(fitLine(`  (${offset + 1}-${offset + visible.length} of ${options.length})`));
      }
      lines.push(fitLine(HINT));
      process.stdout.write(`${lines.join('\n')}\n`);
      renderedLines = lines.length;
    };

    const keepHighlightVisible = (): void => {
      if (highlight < offset) {
        offset = highlight;
      }
      if (highlight >= offset + windowSize) {
        offset = highlight - windowSize + 1;
      }
      offset = Math.min(Math.max(0, offset), maxOffset);
    };

    const finish = (value: string | null): void => {
      if (digitTimer) {
        clearTimeout(digitTimer);
        digitTimer = undefined;
      }
      input.removeListener('keypress', onKeypress);
      input.setRawMode?.(false);
      input.pause();
      eraseRendered();
      resolve(value);
    };

    const moveHighlight = (delta: number): void => {
      digitBuffer = '';
      highlight = Math.min(Math.max(0, highlight + delta), options.length - 1);
      keepHighlightVisible();
      render();
    };

    /**
     * Numbers address the VISIBLE window (rows are renumbered as it scrolls).
     * Digits accumulate briefly so a "10" is reachable without committing;
     * an out-of-range continuation restarts the buffer with the latest digit.
     */
    const jumpToNumber = (digit: string): void => {
      digitBuffer += digit;
      const visibleCount = Math.min(windowSize, options.length - offset);
      let target = Number.parseInt(digitBuffer, 10);
      if (!(target >= 1 && target <= visibleCount)) {
        digitBuffer = digit;
        target = Number.parseInt(digitBuffer, 10);
      }
      if (target >= 1 && target <= visibleCount) {
        highlight = offset + target - 1;
        render();
      } else {
        digitBuffer = '';
      }
      if (digitTimer) {
        clearTimeout(digitTimer);
      }
      digitTimer = setTimeout(() => {
        digitBuffer = '';
      }, DIGIT_BUFFER_RESET_MS);
      digitTimer.unref?.();
    };

    const onKeypress = (str: string | undefined, key: readline.Key): void => {
      if (key?.ctrl && key.name === 'c') {
        finish(null);
        return;
      }

      switch (key?.name) {
        case 'up':
          moveHighlight(-1);
          return;
        case 'down':
          moveHighlight(1);
          return;
        case 'return':
        case 'enter':
          finish(options[highlight].value);
          return;
        case 'escape':
          finish(null);
          return;
        default:
          break;
      }

      if (key?.name?.toLowerCase() === 'q') {
        finish(null);
        return;
      }

      if (str !== undefined && /^\d$/.test(str)) {
        jumpToNumber(str);
      }
    };

    readline.emitKeypressEvents(input);
    input.setRawMode?.(true);
    input.resume();
    input.on('keypress', onKeypress);
    render();
  });
};

/**
 * Typed single-line prompt for true free-text input (model names, adapter args,
 * retries/timeout). Resolves null when the user cancels with Ctrl-C.
 */
export const promptText = (question: string): Promise<string | null> => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: string | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      rl.close();
      resolve(value);
    };

    rl.on('SIGINT', () => settle(null));
    // A closed/EOF stdin (non-TTY edge) resolves null instead of hanging forever.
    rl.on('close', () => settle(null));
    rl.question(question, (answer) => settle(answer));
  });
};
