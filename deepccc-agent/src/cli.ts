/**
 * DeepCCC terminal REPL and JSONL streaming entrypoint — 同步自 ChatCCC
 *
 * Usage:
 *   node bin/deepccc-cli.mjs
 *   node bin/deepccc-cli.mjs --model deepseek-v4-pro
 *   node bin/deepccc-cli.mjs --stream-json --prompt "hello"
 *
 * 交互模式（TTY）下，单轮回复渲染为固定"过程区块"：状态行 + 折叠工具行 +
 * 原地更新正文，不再滚屏刷 JSON；完成/停止/异常后定型留在屏幕上。
 * 非 TTY（管道/CI）或 --plain 回退为纯文本流式输出；--stream-json 机器接口不变。
 */

import * as readline from "node:readline";
import process from "node:process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { listBuiltinContextSessions } from "./context.js";
import { resolveBuiltinSession, type BuiltinResumeRequest } from "./session-select.js";
import { createCtrlCState } from "./sigint.js";
import { buildSkillTemplate } from "./skills.js";
import { reduceProgress } from "./progress/reducer.js";
import { TerminalProgressRenderer } from "./progress/terminal-renderer.js";
import { progressView, type ProgressView } from "./progress/view.js";
import { defaultLogDir, setupFileLogging } from "./file-log.js";
import type { ChatEvent, ChatSessionConfig, ChatSessionOptions } from "./index.js";
import type { PermissionRequest, PermissionResolver } from "./permissions.js";

interface ParsedArgs {
  config: ChatSessionConfig;
  options: ChatSessionOptions;
  listSessions: boolean;
  resume: BuiltinResumeRequest;
  help: boolean;
  streamJson: boolean;
  prompt: string | null;
  /** 强制纯文本流式输出（不用过程区块渲染器），渲染异常时的兜底通道 */
  plain: boolean;
}

interface RuntimeDeps {
  ChatSession: typeof import("./index.js").ChatSession;
  appConfig: typeof import("./config.js").config;
}

interface JsonLine {
  type: string;
  [key: string]: unknown;
}

function parsePositiveIntegerOption(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseProviderOption(value: string): "openai" | "anthropic" {
  const normalized = value.trim().toLowerCase();
  if (normalized === "openai" || normalized === "anthropic") return normalized;
  throw new Error(`--provider must be "openai" or "anthropic", received: ${value}`);
}

function parseArgs(argv = process.argv.slice(2)): ParsedArgs {
  const config: ChatSessionConfig = {};
  const options: ChatSessionOptions = {};
  let listSessions = false;
  let resume: BuiltinResumeRequest;
  let help = false;
  let streamJson = false;
  let prompt: string | null = null;
  let plain = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--provider" && next !== undefined) {
      config.provider = parseProviderOption(next);
      i++;
    } else if (arg === "--model" && next !== undefined) {
      config.model = next;
      i++;
    } else if (arg === "--sub-model" && next !== undefined) {
      config.subModel = next;
      i++;
    } else if (arg === "--effort" && next !== undefined) {
      config.effort = next;
      i++;
    } else if (arg === "--max-output-tokens" && next !== undefined) {
      config.maxOutputTokens = parsePositiveIntegerOption("--max-output-tokens", next);
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
    } else if (arg === "--max-steps" && next !== undefined) {
      options.maxSteps = parsePositiveIntegerOption("--max-steps", next);
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
    } else if (arg === "--plain") {
      plain = true;
    } else if (arg === "--dangerously-bypass-permissions") {
      // 仅保留一个 bypass 入口（对齐 chatccc 调 claude/codex 的 bypass 模式）
      options.permissionMode = "bypass";
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    }
  }

  return { config, options, listSessions, resume, help, streamJson, prompt, plain };
}

async function loadRuntime(): Promise<RuntimeDeps> {
  const [{ ChatSession }, { config: appConfig }] = await Promise.all([
    import("./index.js"),
    import("./config.js"),
  ]);
  return { ChatSession, appConfig };
}

function printHelp(appConfig: RuntimeDeps["appConfig"]): void {
  console.log([
    "DeepCCC terminal agent",
    "",
    "Usage: deepccc-cli [options]",
    "",
    "Options:",
    `  --provider <name>    API protocol: openai or anthropic (current default ${appConfig.provider})`,
    `  --model <name>       Model name (current default ${appConfig.model})`,
    `  --sub-model <name>   Sub-model for lightweight steps (compaction/task; empty = follow main model)`,
    `  --effort <level>     Reasoning effort: none/minimal/low/medium/high/xhigh/max (overrides config.effort)`,
    `  --max-output-tokens <n>  Maximum output tokens (unset = Provider default)`,
    `  --base-url <url>     Provider API base URL (current default ${appConfig.baseURL})`,
    "  --api-key <key>      API key",
    "  --cwd <path>         Working directory",
    "  --max-steps <n>      Optional tool-step limit. Omit for no step limit",
    "  --resume [id]        Resume latest cwd session, or the explicit session id",
    "  --list-sessions      List saved sessions and exit",
    "  --stream-json        One-shot mode: write JSONL events to stdout",
    "  --prompt <text>      Prompt text for --stream-json",
    "  --plain              Force plain streaming output (no progress block renderer)",
    "  --dangerously-bypass-permissions  Skip all permission prompts (aligns with chatccc's bypass mode)",
    "  --help, -h           Show help",
    "",
    "Permissions:",
    "  Default mode asks before high-risk commands (rm -rf, git push --force, ...).",
    "  Answer y = allow once, a = allow always (saved to ~/.deepccc/allow.json),",
    "  n = deny, g = allow all for this session. Read-only tools and normal file",
    "  edits never prompt. In non-interactive mode (--stream-json) high-risk",
    "  commands are denied unless --dangerously-bypass-permissions is passed.",
    "",
    "Default config source:",
    "  ~/.deepccc/config.json, DEEPCCC_* environment variables, or DEEPSEEK_* aliases",
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
    console.log("No saved DeepCCC sessions");
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
  if (event.type === "status") {
    writeJsonLine({
      type: "status",
      phase: event.phase,
    });
  } else if (event.type === "text") {
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
    model: args.config.model ?? runtime.appConfig.model,
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

/**
 * 交互模式下渲染器独占终端 stdout：普通日志只写日志文件、不回显到终端，
 * 避免生成过程中任何 console 输出混入过程区块、破坏行数计数（导致重绘
 * 上移不足、把上方历史内容"吃掉"）。错误提示（console.error）保留回显。
 */
function muteConsoleLogToFile(logPath: string): void {
  const writeFile = (level: string, args: unknown[]): void => {
    try {
      const text = args
        .map((a) =>
          typeof a === "string" ? a
            : a instanceof Error ? (a.stack ?? a.message)
            : JSON.stringify(a))
        .join(" ");
      appendFileSync(logPath, `[${new Date().toISOString()}] [${level}] ${text}\n`, "utf8");
    } catch {
      // 日志系统自身失败不影响主流程
    }
  };
  console.log = (...args: unknown[]) => writeFile("LOG", args);
  console.info = (...args: unknown[]) => writeFile("INFO", args);
  console.warn = (...args: unknown[]) => writeFile("WARN", args);
}

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

  console.log(`${C.dim}DeepCCC agent${C.reset}`);
  console.log(`${C.dim}Provider: ${args.config.provider ?? appConfig.provider}${C.reset}`);
  console.log(`${C.dim}Model: ${args.config.model ?? appConfig.model}${C.reset}`);
  console.log(`${C.dim}Directory: ${cwd}${C.reset}`);
  console.log(`${C.dim}Session: ${resolvedSession.sessionId} (${resolvedSession.mode === "new" ? "new" : "resumed"})${C.reset}`);
  console.log(`${C.dim}Type a message to chat. Double Ctrl+C interrupts generation or exits. Type exit to quit.${C.reset}`);
  console.log("");

  // 交互渲染模式下 console 输出只写日志文件、不回显到终端（渲染器独占 stdout，
  // 避免生成中日志混入区块破坏行数）。--plain 无渲染器，不需要静音。
  if (process.stdout.isTTY === true && !args.plain) {
    muteConsoleLogToFile(setupFileLogging(defaultLogDir(), "index").logPath);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.green}>${C.reset} `,
  });

  // 权限交互：暂停过程区块渲染（恢复光标）→ readline 提问 → 恢复渲染。
  // activeRenderer/activeView 由每轮 line 处理器维护，resolver 只在工具
  // 执行期间被调用，此时当前轮的区块正处于运行中。
  let activeRenderer: TerminalProgressRenderer | null = null;
  let activeView: ProgressView | null = null;
  const permissionResolver: PermissionResolver = async (request: PermissionRequest) => {
    const renderer = activeRenderer;
    const view = activeView;
    if (renderer) renderer.dispose();
    process.stdout.write(`\n${C.yellow}⚠️  高危操作需要确认${C.reset}\n`);
    process.stdout.write(`${C.dim}${request.detail}${C.reset}\n`);
    const answer = await new Promise<string>((resolve) => {
      rl.question(
        `${C.green}允许一次(y) / 永远允许(a) / 拒绝(n) / 本会话允许所有(g) >${C.reset} `,
        resolve,
      );
    });
    if (renderer && view) renderer.begin(view);
    const v = answer.trim().toLowerCase();
    if (v === "y") return "allow";
    if (v === "a") return "allow-always";
    if (v === "g") return "allow-session";
    return "deny";
  };

  let session: InstanceType<typeof ChatSession>;
  try {
    session = new ChatSession(args.config, {
      ...args.options,
      cwd,
      persist: true,
      sessionId: resolvedSession.sessionId,
      permissionResolver,
    });
  } catch (err) {
    console.error(`${C.yellow}${(err as Error).message}${C.reset}`);
    process.exit(1);
  }

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
      process.stdout.write(`${C.dim}bye${C.reset}\n`);
      rl.close();
      return;
    }

    if (input === "/clear") {
      session.reset();
      process.stdout.write(`${C.dim}session cleared${C.reset}\n`);
      rl.prompt();
      return;
    }

    if (input === "/history") {
      process.stdout.write(`${C.dim}${session.turnCount} conversation turns${C.reset}\n`);
      rl.prompt();
      return;
    }

    if (input === "/sessions") {
      printSessions();
      rl.prompt();
      return;
    }

    currentAbort = new AbortController();
    const signal = currentAbort.signal;

    // TTY 下用"过程区块"（飞书过程卡片的终端形态）：固定区域原地更新、
    // 工具调用折叠为单行；非 TTY（管道/CI）或 --plain 回退为纯文本流式输出。
    const useTerminalBlock = process.stdout.isTTY === true && !args.plain;
    const renderer = useTerminalBlock ? new TerminalProgressRenderer() : null;
    let view: ProgressView | null = null;
    if (renderer) {
      view = progressView({ headerTitle: "生成中..." });
      activeRenderer = renderer;
      activeView = view;
      // 先回行首换行再 begin：让过程区块从输入行下方开始，避免首帧 \r\x1b[2K
      // 清掉用户刚输入的问题行（历史文本不被刷掉）。\r\n 兼容 readline
      // 行提交后光标仍停在输入行行尾的情况。
      process.stdout.write("\r\n");
      renderer.begin(view);
    }
    let rendererEnded = false;

    try {
      let lastAccumulated = "";
      for await (const event of session.chat(input, signal)) {
        if (renderer && view) {
          view = reduceProgress(view, event);
          if (event.type === "text" || event.type === "compact" || event.type === "status") {
            renderer.render(view);
          } else {
            renderer.flush();
          }
        } else if (event.type === "status") {
          console.log(`${C.dim}[${event.phase === "compacting" ? "compacting context" : "generating reply"}]${C.reset}`);
        } else if (event.type === "text") {
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
      if (renderer && view) {
        const aborted = err instanceof Error && err.name === "AbortError";
        view = progressView({ ...view, status: aborted ? "stopped" : "error", showStop: false });
        renderer.end(view);
        rendererEnded = true;
        process.stdout.write("\n");
      }
      console.error(`\n${C.yellow}[error] ${(err as Error).message}${C.reset}`);
    } finally {
      activeRenderer = null;
      activeView = null;
      if (renderer && view && !rendererEnded) {
        // 定型终态区块（完成/已停止/异常结束）留在屏幕上，恢复光标
        renderer.end(view);
        process.stdout.write("\n");
      }
      currentAbort = null;
      ctrlCState.reset();
    }

    rl.prompt();
  });

  rl.on("SIGINT", () => {
    const action = ctrlCState.press(currentAbort !== null);

    if (action === "exit") {
      console.error(`\n${C.dim}bye${C.reset}`);
      rl.close();
      return;
    }

    if (action === "interrupt") {
      console.error(`\n${C.yellow}[interrupting...]${C.reset}`);
      currentAbort?.abort();
      currentAbort = null;
      return;
    }

    if (action === "arm-interrupt") {
      console.error(`\n${C.dim}Press Ctrl+C again to interrupt current response${C.reset}`);
      return;
    }

    if (action === "arm-exit") {
      console.error(`\n${C.dim}Press Ctrl+C again to exit, or type exit${C.reset}`);
      rl.prompt();
    }
  });

  rl.on("close", () => {
    process.stdout.write("\n");
    process.exit(0);
  });
}

/**
 * skill create 子命令：deepccc-cli skill create <name> [--scope global|project] [--description "..."]
 * 默认创建为全局技能（~/.deepccc/skills/<name>/SKILL.md，Codex 结构）；
 * --scope project 创建为项目技能（<cwd>/.deepccc/skills/<name>/SKILL.md）。
 * 新技能在下一次对话自动生效（技能索引每次 chat() 前重扫）。
 */
function runSkillCreate(argv: string[]): void {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const name = positional[0];
  if (!name) {
    console.error(
      "usage: deepccc-cli skill create <name> [--scope global|project] [--description \"...\"]",
    );
    process.exit(1);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    console.error(`invalid skill name: ${name}（允许字母/数字/._-，不能以 . 或 - 开头）`);
    process.exit(1);
  }

  const scopeIdx = argv.indexOf("--scope");
  const scope = scopeIdx !== -1 && argv[scopeIdx + 1] === "project" ? "project" : "global";
  const descIdx = argv.indexOf("--description");
  const description = descIdx !== -1 ? (argv[descIdx + 1] ?? "") : "";

  const base =
    scope === "project"
      ? join(process.cwd(), ".deepccc", "skills")
      : join(homedir(), ".deepccc", "skills");
  const skillPath = join(base, name, "SKILL.md");

  if (existsSync(skillPath)) {
    console.error(`skill already exists: ${skillPath}`);
    process.exit(1);
  }

  try {
    mkdirSync(join(base, name), { recursive: true });
    writeFileSync(skillPath, buildSkillTemplate(name, description), "utf8");
  } catch (err) {
    console.error(`failed to create skill: ${(err as Error).message}`);
    process.exit(1);
  }

  console.log(`created skill: ${skillPath}`);
  console.log(`scope: ${scope === "project" ? "project（仅当前项目生效）" : "global（所有项目生效）"}`);
  if (description) console.log(`description: ${description}`);
  console.log("hot reload: 下一次对话自动生效，无需重启");
}

async function main(): Promise<void> {
  // skill create 子命令：deepccc-cli skill create <name> [--scope global|project] [--description "..."]
  // 默认创建在全局 ~/.deepccc/skills（Codex 目录结构），--scope project 创建到 <cwd>/.deepccc/skills。
  if (process.argv[2] === "skill" && process.argv[3] === "create") {
    runSkillCreate(process.argv.slice(4));
    return;
  }

  const args = parseArgs();

  if (args.streamJson) {
    const code = await runStreamJson(args);
    process.exitCode = code;
    return;
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
