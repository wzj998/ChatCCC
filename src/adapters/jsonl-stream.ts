import { createInterface } from "node:readline";

interface JsonLineSink {
  writeLine(line: string): void;
}

export const DEFAULT_BAD_JSON_IDLE_TIMEOUT_MS = 120_000;
export const BAD_JSON_IDLE_TIMEOUT_CODE = "BAD_JSON_IDLE_TIMEOUT";

export class BadJsonIdleTimeoutError extends Error {
  readonly code = BAD_JSON_IDLE_TIMEOUT_CODE;
  readonly tool: string;
  readonly tag: string;
  readonly timeoutMs: number;
  readonly lineNumber: number;
  readonly lineExcerpt: string;
  readonly parseError: string;

  constructor(args: {
    tool: string;
    tag: string;
    timeoutMs: number;
    lineNumber: number;
    lineExcerpt: string;
    parseError: string;
  }) {
    super(
      `${args.tool} stream stopped after invalid JSON for ${args.timeoutMs}ms ` +
        `(tag=${args.tag}, line=${args.lineNumber}): ${args.lineExcerpt}`,
    );
    this.name = "BadJsonIdleTimeoutError";
    this.tool = args.tool;
    this.tag = args.tag;
    this.timeoutMs = args.timeoutMs;
    this.lineNumber = args.lineNumber;
    this.lineExcerpt = args.lineExcerpt;
    this.parseError = args.parseError;
  }
}

export interface ReadJsonLinesDoneInfo {
  lineCount: number;
  signalAborted: boolean;
  protocolError: BadJsonIdleTimeoutError | null;
}

export interface ReadJsonLinesOptions<T> {
  input: NodeJS.ReadableStream;
  tool: string;
  tag?: string;
  signal?: AbortSignal;
  rawLog?: JsonLineSink | null;
  idleTimeoutMs?: number;
  parse?: (line: string) => T;
  onRawLine?: (line: string, lineNumber: number) => void;
  onParsedLine?: (value: T, line: string, lineNumber: number) => void;
  onDone?: (info: ReadJsonLinesDoneInfo) => void;
}

function isJsonLike(line: string): boolean {
  return line.startsWith("{") || line.startsWith("[");
}

function lineExcerpt(line: string): string {
  const max = 500;
  return line.length <= max ? line : `${line.slice(0, max)}...`;
}

function parseErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function* readJsonLinesWithBadJsonIdleWatchdog<T>({
  input,
  tool,
  tag = tool,
  signal,
  rawLog,
  idleTimeoutMs = DEFAULT_BAD_JSON_IDLE_TIMEOUT_MS,
  parse = (line: string) => JSON.parse(line) as T,
  onRawLine,
  onParsedLine,
  onDone,
}: ReadJsonLinesOptions<T>): AsyncGenerator<T> {
  const rl = createInterface({ input, crlfDelay: Infinity });
  let lineCount = 0;
  let protocolError: BadJsonIdleTimeoutError | null = null;
  let badJsonIdleTimer: ReturnType<typeof setTimeout> | null = null;

  const clearBadJsonIdleTimer = () => {
    if (!badJsonIdleTimer) return;
    clearTimeout(badJsonIdleTimer);
    badJsonIdleTimer = null;
  };

  const armBadJsonIdleTimer = (line: string, lineNumber: number, error: unknown) => {
    if (idleTimeoutMs <= 0) return;
    clearBadJsonIdleTimer();
    badJsonIdleTimer = setTimeout(() => {
      protocolError = new BadJsonIdleTimeoutError({
        tool,
        tag,
        timeoutMs: idleTimeoutMs,
        lineNumber,
        lineExcerpt: lineExcerpt(line),
        parseError: parseErrorMessage(error),
      });
      rl.close();
    }, idleTimeoutMs);
    const timerWithUnref = badJsonIdleTimer as ReturnType<typeof setTimeout> & {
      unref?: () => void;
    };
    timerWithUnref.unref?.();
  };

  const onAbort = () => {
    clearBadJsonIdleTimer();
    rl.close();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    for await (const line of rl) {
      if (signal?.aborted) break;
      lineCount++;
      onRawLine?.(line, lineCount);
      const trimmed = line.trim();
      if (!trimmed) continue;

      clearBadJsonIdleTimer();
      rawLog?.writeLine(trimmed);

      try {
        const parsed = parse(trimmed);
        onParsedLine?.(parsed, trimmed, lineCount);
        yield parsed;
      } catch (error) {
        if (isJsonLike(trimmed)) {
          armBadJsonIdleTimer(trimmed, lineCount, error);
        }
      }
    }

    if (protocolError && !signal?.aborted) {
      throw protocolError;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    clearBadJsonIdleTimer();
    rl.close();
    onDone?.({
      lineCount,
      signalAborted: signal?.aborted ?? false,
      protocolError,
    });
  }
}
