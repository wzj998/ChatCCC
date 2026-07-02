/**
 * ChatCCC builtin Agent terminal REPL and JSONL streaming entrypoint.
 *
 * Usage:
 *   npx tsx src/builtin/cli.ts
 *   npx tsx src/builtin/cli.ts --model deepseek-v4-pro
 *   npx tsx src/builtin/cli.ts --stream-json --prompt "hello"
 */

import * as readline from "node:readline";
import * as process from "node:process";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { listBuiltinContextSessions } from "./context.js";
import { resolveBuiltinSession, type BuiltinResumeRequest } from "./session-select.js";
import { createCtrlCState } from "./sigint.js";
import type { ChatEvent, ChatSessionConfig, ChatSessionOptions } from "./index.js";

interface ParsedArgs {
  config: ChatSessionConfig;
  options: ChatSessionOptions;
  listSessions: boolean;
  resume: BuiltinResumeRequest;
  help: boolean;
  streamJson: boolean;
  prompt: string | null;
}

interface RuntimeDeps {
  ChatSession: typeof import("./index.js").ChatSession;
  appConfig: typeof import("../config.ts").config;
}

interface JsonLine {
  type: string;
  [key: string]: unknown;
}

function parseArgs(argv = process.argv.slice(2)): ParsedArgs {
  const config: ChatSessionConfig = {};
  const options: ChatSessionOptions = {};
  let listSessions = false;
  let resume: BuiltinResumeRequest;
  let help = false;
  let streamJson = false;
  let prompt: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--model" && next !== undefined) {
      config.model = next;
      i++;
    } else if (arg === "--base-url" && next !== undefined) {
      config.baseURL = next;
      i++;
    } else if (arg === "--api-key" && next !== undefined) {
      config.apiKey = next;
      i++;
    } else if (arg === "--cwd" && next !== undefined) {
      options.cwd = next;
      i++;
    } else if (arg === "--resume") {
      if (next !== undefined && !next.startsWith("--")) {
        resume = next;
        i++;
      } else {
        resume = true;
      }
    } else if (arg === "--list-sessions") {
      listSessions = true;
    } else if (arg === "--stream-json") {
      streamJson = true;
    } else if (arg === "--prompt" && next !== undefined) {
      prompt = next;
      i++;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    }
  }

  return { config, options, listSessions, resume, help, streamJson, prompt };
}

async function loadRuntime(): Promise<RuntimeDeps> {
  const [{ ChatSession }, { config: appConfig }] = await Promise.all([
    import("./index.js"),
    import("../config.ts"),
  ]);
  return { ChatSession, appConfig };
}

function printHelp(appConfig: RuntimeDeps["appConfig"]): void {
  console.log([
    "ChatCCC builtin Agent terminal REPL",
    "",
    "Usage: npx tsx src/builtin/cli.ts [options]",
    "",
    "Options:",
    `  --model <name>       Model name (overrides config.ccc.model, current default ${appConfig.ccc.model})`,
    `  --base-url <url>     API base URL (current default ${appConfig.ccc.DEEPSEEK_BASE_URL})`,
    "  --api-key <key>      API key (overrides config.ccc.DEEPSEEK_API_KEY)",
    "  --cwd <path>         Working directory",
    "  --resume [id]        Resume latest cwd session, or the explicit session id",
    "  --list-sessions      List saved ccc sessions and exit",
    "  --stream-json        One-shot mode: write JSONL events to stdout",
    "  --prompt <text>      Prompt text for --stream-json",
    "  --help, -h           Show help",
    "",
    "Default config source:",
    "  ~/.chatccc/config.json ccc.DEEPSEEK_API_KEY / ccc.DEEPSEEK_BASE_URL / ccc.model",
    "",
  ].join("\n"));
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

function printSessions(streamJson = false): void {
  const sessions = listBuiltinContextSessions();
  if (streamJson) {
    writeJsonLine({
      type: "sessions",
      sessions: sessions.map((session) => ({
        session_id: session.sessionId,
        turns: session.totalMessages,
        compacted_messages: session.compactedMessages,
        has_summary: session.hasSummary,
        updated_at: session.updatedAt,
        cwd: session.cwd,
      })),
    });
    return;
  }

  if (sessions.length === 0) {
    console.log("No saved ccc sessions");
    return;
  }

  for (const session of sessions) {
    const summary = session.hasSummary ? " summary=yes" : "";
    const cwd = session.cwd ? ` cwd=${session.cwd}` : "";
    console.log(`${session.sessionId}  turns=${session.totalMessages} compacted=${session.compactedMessages}${summary} updated=${formatTime(session.updatedAt)}${cwd}`);
  }
}

function stringifyConsoleArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function redirectConsoleLogsToStderr(): void {
  const write = (...args: unknown[]) => {
    process.stderr.write(`${args.map(stringifyConsoleArg).join(" ")}\n`);
  };
  console.log = write;
  console.info = write;
  console.warn = write;
}

function writeJsonLine(event: JsonLine): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function streamJsonEvent(event: ChatEvent): void {
  if (event.type === "text") {
    writeJsonLine({
      type: "text_delta",
      text: event.text,
      accumulated: event.accumulated,
    });
  } else if (event.type === "compact") {
    writeJsonLine({
      type: "compact",
      compacted_messages: event.compactedMessages,
    });
  } else if (event.type === "tool_use") {
    writeJsonLine({
      type: "tool_call",
      id: event.id,
      name: event.name,
      input: event.input,
    });
  } else if (event.type === "tool_result") {
    writeJsonLine({
      type: "tool_result",
      tool_call_id: event.tool_use_id,
      name: event.name,
      content: event.content,
      is_error: event.is_error,
    });
  } else if (event.type === "done") {
    writeJsonLine({
      type: "done",
      text: event.text,
    });
  } else if (event.type === "error") {
    writeJsonLine({
      type: "error",
      message: event.message,
    });
  }
}

async function readPromptFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function runStreamJson(args: ParsedArgs): Promise<number> {
  redirectConsoleLogsToStderr();

  if (args.listSessions) {
    printSessions(true);
    return 0;
  }

  const prompt = args.prompt ?? (!process.stdin.isTTY ? await readPromptFromStdin() : "");
  if (!prompt.trim()) {
    writeJsonLine({ type: "error", message: "--stream-json requires --prompt <text> or stdin input" });
    return 1;
  }

  let runtime: RuntimeDeps;
  try {
    runtime = await loadRuntime();
  } catch (err) {
    writeJsonLine({ type: "error", message: (err as Error).message });
    return 1;
  }

  const cwd = resolvePath(args.options.cwd ?? process.cwd());
  let resolvedSession;
  try {
    resolvedSession = resolveBuiltinSession({ cwd, resume: args.resume });
  } catch (err) {
    writeJsonLine({ type: "error", message: (err as Error).message });
    return 1;
  }

  let session: InstanceType<RuntimeDeps["ChatSession"]>;
  try {
    session = new runtime.ChatSession(args.config, {
      ...args.options,
      cwd,
      persist: true,
      sessionId: resolvedSession.sessionId,
    });
  } catch (err) {
    writeJsonLine({ type: "error", message: (err as Error).message });
    return 1;
  }

  writeJsonLine({
    type: "start",
    session_id: resolvedSession.sessionId,
    mode: resolvedSession.mode,
    cwd,
    model: args.config.model ?? runtime.appConfig.ccc.model,
  });

  try {
    for await (const event of session.chat(prompt)) {
      streamJsonEvent(event);
    }
    return 0;
  } catch (err) {
    writeJsonLine({ type: "error", message: (err as Error).message });
    return 1;
  }
}

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
};

async function runRepl(args: ParsedArgs): Promise<void> {
  const { ChatSession, appConfig } = await loadRuntime();

  const cwd = resolvePath(args.options.cwd ?? process.cwd());
  let resolvedSession;
  try {
    resolvedSession = resolveBuiltinSession({ cwd, resume: args.resume });
  } catch (err) {
    console.error(`${C.yellow}${(err as Error).message}${C.reset}`);
    process.exit(1);
  }

  console.log(`${C.dim}ChatCCC builtin Agent${C.reset}`);
  console.log(`${C.dim}Model: ${args.config.model ?? appConfig.ccc.model}${C.reset}`);
  console.log(`${C.dim}Directory: ${cwd}${C.reset}`);
  console.log(`${C.dim}Session: ${resolvedSession.sessionId} (${resolvedSession.mode === "new" ? "new" : "resumed"})${C.reset}`);
  console.log(`${C.dim}Type a message to chat. Double Ctrl+C interrupts generation or exits. Type exit to quit.${C.reset}`);
  console.log("");

  let session: InstanceType<typeof ChatSession>;
  try {
    session = new ChatSession(args.config, {
      ...args.options,
      cwd,
      persist: true,
      sessionId: resolvedSession.sessionId,
    });
  } catch (err) {
    console.error(`${C.yellow}${(err as Error).message}${C.reset}`);
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.green}>${C.reset} `,
  });

  let currentAbort: AbortController | null = null;
  const ctrlCState = createCtrlCState();

  rl.prompt();

  rl.on("line", async (line: string) => {
    ctrlCState.reset();
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (input === "exit") {
      console.log(`${C.dim}bye${C.reset}`);
      rl.close();
      return;
    }

    if (input === "/clear") {
      session.reset();
      console.log(`${C.dim}session cleared${C.reset}`);
      rl.prompt();
      return;
    }

    if (input === "/history") {
      console.log(`${C.dim}${session.turnCount} conversation turns${C.reset}`);
      rl.prompt();
      return;
    }

    currentAbort = new AbortController();
    const signal = currentAbort.signal;

    try {
      let lastAccumulated = "";
      for await (const event of session.chat(input, signal)) {
        if (event.type === "text") {
          const newText = event.accumulated.slice(lastAccumulated.length);
          process.stdout.write(newText);
          lastAccumulated = event.accumulated;
        } else if (event.type === "done") {
          if (lastAccumulated) console.log("");
          console.log(`${C.dim}[done]${C.reset}`);
        } else if (event.type === "compact") {
          console.log(`${C.dim}[context compacted: ${event.compactedMessages} old messages]${C.reset}`);
        } else if (event.type === "tool_use") {
          console.log(`\n${C.dim}[tool] ${event.name} ${stringifyConsoleArg(event.input)}${C.reset}`);
        } else if (event.type === "tool_result") {
          const status = event.is_error ? "error" : "ok";
          console.log(`${C.dim}[tool result] ${event.name ?? event.tool_use_id} ${status}${C.reset}`);
        } else if (event.type === "error") {
          console.log(`\n${C.yellow}[error] ${event.message}${C.reset}`);
        }
      }
    } catch (err) {
      console.log(`\n${C.yellow}[error] ${(err as Error).message}${C.reset}`);
    } finally {
      currentAbort = null;
      ctrlCState.reset();
    }

    rl.prompt();
  });

  rl.on("SIGINT", () => {
    const action = ctrlCState.press(currentAbort !== null);

    if (action === "exit") {
      console.log(`\n${C.dim}bye${C.reset}`);
      rl.close();
      return;
    }

    if (action === "interrupt") {
      console.log(`\n${C.yellow}[interrupting...]${C.reset}`);
      currentAbort?.abort();
      currentAbort = null;
      return;
    }

    if (action === "arm-interrupt") {
      console.log(`\n${C.dim}Press Ctrl+C again to interrupt current response${C.reset}`);
      return;
    }

    if (action === "arm-exit") {
      console.log(`\n${C.dim}Press Ctrl+C again to exit, or type exit${C.reset}`);
      rl.prompt();
    }
  });

  rl.on("close", () => {
    console.log("");
    process.exit(0);
  });
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.streamJson) {
    const code = await runStreamJson(args);
    process.exit(code);
  }

  if (args.help) {
    const { appConfig } = await loadRuntime();
    printHelp(appConfig);
    return;
  }

  if (args.listSessions) {
    printSessions();
    return;
  }

  await runRepl(args);
}

function isDirectCliInvocation(): boolean {
  const current = resolvePath(fileURLToPath(import.meta.url));
  const invoked = process.argv[1] ? resolvePath(process.argv[1]) : "";
  return current === invoked;
}

if (isDirectCliInvocation()) {
  main().catch((err) => {
    console.error(`${C.yellow}startup failed: ${(err as Error).message}${C.reset}`);
    process.exit(1);
  });
}
