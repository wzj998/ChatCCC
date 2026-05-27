// =============================================================================
// claude-adapter.ts — Claude CLI 适配器
// =============================================================================
// 通过直接 spawn claude.exe（不再使用 @anthropic-ai/claude-agent-sdk JS API）
// 以确保 --mcp-config 参数能正确传递给 CLI 子进程，加载用户 MCP 服务器。
// =============================================================================

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";

import type {
  ToolAdapter,
  UnifiedBlock,
  UnifiedStreamMessage,
  CreateSessionResult,
  SessionInfo,
  ToolPromptOptions,
} from "./adapter-interface.ts";
import { killProcessTree } from "./proc-tree-kill.ts";
import {
  defaultClaudeSessionMetaStore,
  type ClaudeSessionMetaStore,
} from "./claude-session-meta-store.ts";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 根据当前平台动态解析 claude-agent-sdk 二进制路径 */
function resolveClaudeBinary(): string {
  const platform = process.platform; // 'win32', 'linux', 'darwin'
  const arch = process.arch;         // 'x64', 'arm64'

  // 通过 Node 模块解析找到 SDK 主包目录，确保测试和生产环境一致
  const _require = createRequire(import.meta.url);
  const sdkMainDir = dirname(_require.resolve("@anthropic-ai/claude-agent-sdk"));

  // 读取 manifest.json 获取各平台二进制文件名
  let platforms: Record<string, { binary: string }> | null = null;
  try {
    const manifest = JSON.parse(
      readFileSync(join(sdkMainDir, "manifest.json"), "utf-8"),
    ) as { platforms?: Record<string, { binary: string }> };
    platforms = manifest.platforms ?? null;
  } catch { /* manifest 缺失时用默认规则推断 */ }

  // Linux 上需区分 musl / glibc，先检测 musl 变体
  const candidates: string[] = [];
  if (platform === "linux") {
    candidates.push(`${platform}-${arch}-musl`, `${platform}-${arch}`);
  } else {
    candidates.push(`${platform}-${arch}`);
  }

  for (const triple of candidates) {
    const binaryName = platforms?.[triple]?.binary
      ?? (platform === "win32" ? "claude.exe" : "claude");
    const pkgDir = join(sdkMainDir, "..", `claude-agent-sdk-${triple}`);
    if (!existsSync(pkgDir)) continue;
    const exePath = join(pkgDir, binaryName);
    if (existsSync(exePath)) return exePath;
  }

  throw new Error(
    `No Claude CLI binary found for platform ${platform}-${arch}. ` +
    `Tried: ${candidates.map((c) => `@anthropic-ai/claude-agent-sdk-${c}`).join(", ")}`,
  );
}

const CLAUDE_EXE = resolveClaudeBinary();

// ---------------------------------------------------------------------------
// 类型别名（CLI JSONL 消息格式，与旧 SDK 消息格式兼容）
// ---------------------------------------------------------------------------

interface SdkContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  query?: string;
  [key: string]: unknown;
}

interface SdkMessageLike {
  type?: string;
  subtype?: string;
  message?: { content?: SdkContentBlock[] };
  compact_metadata?: {
    trigger?: "manual" | "auto";
    pre_tokens?: number;
    post_tokens?: number;
  };
  session_id?: string;
  model?: string;
  cwd?: string;
}

// ---------------------------------------------------------------------------
// ClaudeAdapterOptions
// ---------------------------------------------------------------------------

export interface ClaudeAdapterOptions {
  model: string;
  subagentModel?: string;
  effort: string;
  /** Anthropic API Key（选填，留空则不注入环境变量） */
  apiKey?: string;
  /** Anthropic 兼容 API Base URL（选填，留空则不注入环境变量） */
  baseUrl?: string;
  /** 判断字段是否为"不传给 CLI"的占位（空字符串/全空白） */
  isEmpty: (value: string) => boolean;
  /** 注入自定义 meta 持久化 store（测试用）；未提供时使用全局默认实例。 */
  metaStore?: ClaudeSessionMetaStore;
}

// ---------------------------------------------------------------------------
// buildCliEnv — 为 CLI 子进程构造 env（仅子进程级别，不污染主进程）
// ---------------------------------------------------------------------------

function buildCliEnv(
  subagentModel: string | undefined,
  apiKey: string | undefined,
  baseUrl: string | undefined,
): Record<string, string | undefined> | undefined {
  const subagentModelTrim = (subagentModel ?? "").trim();
  const apiKeyTrim = (apiKey ?? "").trim();
  const baseUrlTrim = (baseUrl ?? "").trim();

  if (!subagentModelTrim && !apiKeyTrim && !baseUrlTrim) return undefined;

  const env: Record<string, string | undefined> = { ...process.env };
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_MODEL;
  delete env.ANTHROPIC_DEFAULT_OPUS_MODEL;
  delete env.ANTHROPIC_DEFAULT_SONNET_MODEL;
  delete env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  delete env.CLAUDE_CODE_EFFORT_LEVEL;

  if (subagentModelTrim) env.CLAUDE_CODE_SUBAGENT_MODEL = subagentModelTrim;
  if (apiKeyTrim) env.ANTHROPIC_API_KEY = apiKeyTrim;
  if (baseUrlTrim) env.ANTHROPIC_BASE_URL = baseUrlTrim;

  return env;
}

// ---------------------------------------------------------------------------
// MCP 配置读取
// ---------------------------------------------------------------------------

function readMcpConfigJson(): string | null {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  try {
    if (!existsSync(settingsPath)) return null;
    const raw = readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(raw);
    const mcpServers = settings?.mcpServers;
    if (!mcpServers || Object.keys(mcpServers).length === 0) return null;
    // CLI 期望 {"mcpServers": {...}} 格式，而非裸 mcpServers 值
    return JSON.stringify({ mcpServers });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 诊断日志
// ---------------------------------------------------------------------------

function logMcpConfig(): void {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  const ts = new Date().toISOString();
  try {
    if (!existsSync(settingsPath)) {
      console.log(`[${ts}] [MCP-DIAG] settings.json not found at ${settingsPath}`);
      return;
    }
    const raw = readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(raw);
    const mcpServers = settings?.mcpServers;
    if (!mcpServers || Object.keys(mcpServers).length === 0) {
      console.log(`[${ts}] [MCP-DIAG] No mcpServers configured in settings.json`);
      return;
    }
    console.log(`[${ts}] [MCP-DIAG] mcpServers found: ${JSON.stringify(Object.keys(mcpServers))}`);
    for (const [name, cfg] of Object.entries(mcpServers) as [string, { type?: string; command?: string; args?: string[] }][]) {
      console.log(`[${ts}] [MCP-DIAG]   ${name}: type=${cfg.type}, command=${cfg.command}, args=${JSON.stringify(cfg.args)}`);
    }
  } catch (err) {
    console.log(`[${ts}] [MCP-DIAG] Failed to read settings.json: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// normalizeSdkMessage — CLI JSONL 消息 → UnifiedStreamMessage | null
// （CLI 与 SDK 使用相同 JSONL 格式，导出名保留以兼容现有测试）
// ---------------------------------------------------------------------------

export function normalizeSdkMessage(msg: SdkMessageLike): UnifiedStreamMessage | null {
  if (
    (msg.type === "assistant" || msg.type === "user") &&
    msg.message?.content
  ) {
    const blocks: UnifiedBlock[] = [];
    for (const block of msg.message.content) {
      if (block.type === "thinking" && block.thinking) {
        blocks.push({ type: "thinking", thinking: block.thinking });
      } else if (block.type === "tool_use") {
        blocks.push({
          type: "tool_use",
          id: (block as { id?: string }).id,
          name: block.name ?? "unknown",
          input: block.input,
        });
      } else if (block.type === "tool_result") {
        blocks.push({
          type: "tool_result",
          tool_use_id: block.tool_use_id ?? "",
          content: block.content,
          is_error: block.is_error,
        });
      } else if (block.type === "redacted_thinking") {
        blocks.push({ type: "redacted_thinking" });
      } else if (block.type === "search_result") {
        blocks.push({
          type: "search_result",
          query: block.query ?? "",
        });
      } else if (block.type === "text" && block.text) {
        // 跳过 user 消息中的 text block：--replay-user-messages 会重放
        // 之前的用户消息（含内嵌的 IM skill prompt），这些不应出现在最终回复中
        if (msg.type === "user") continue;
        blocks.push({ type: "text", text: block.text });
      }
    }
    return { type: msg.type, blocks };
  }

  if (msg.type === "system" && msg.subtype === "compact_boundary") {
    const meta = msg.compact_metadata;
    if (!meta) return null;
    return {
      type: "system",
      blocks: [
        {
          type: "compact_boundary",
          trigger: meta.trigger ?? "auto",
          pre_tokens: meta.pre_tokens ?? 0,
          post_tokens: meta.post_tokens,
        },
      ],
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// CLI spawn helpers
// ---------------------------------------------------------------------------

function buildCliArgs(
  model: string,
  effort: string,
  isEmpty: (value: string) => boolean,
  mcpConfigJson: string | null,
  extraArgs: string[],
): string[] {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--setting-sources", "user,project,local",
    "--permission-mode", "bypassPermissions",
    "--dangerously-skip-permissions",
    "--settings", "{\"maxTurns\":0}",
  ];

  if (!isEmpty(model)) args.push("--model", model);
  if (!isEmpty(effort)) args.push("--effort", effort);

  // extraArgs（如 prompt "ok" 或 --resume <id>）必须在 --mcp-config 之前，
  // 因为 --mcp-config 接受多个空格分隔的值，会把后续非 flag 参数都当作 MCP 配置
  args.push(...extraArgs);

  if (mcpConfigJson) args.push("--mcp-config", mcpConfigJson);

  const ts = new Date().toISOString();
  const safeArgs = args.filter(a => a !== mcpConfigJson);
  console.log(`[${ts}] [CLAUDE-CLI] spawn: ${CLAUDE_EXE} ${safeArgs.join(" ")}`);
  if (mcpConfigJson) {
    console.log(`[${ts}] [CLAUDE-CLI] --mcp-config: ${mcpConfigJson}`);
  }

  return args;
}

function spawnCli(
  args: string[],
  cwd: string,
  env: Record<string, string | undefined> | undefined,
  pipeStdin: boolean,
): ChildProcess {
  const proc = spawn(CLAUDE_EXE, args, {
    cwd,
    stdio: [pipeStdin ? "pipe" : "ignore", "pipe", "pipe"],
    windowsHide: true,
    env: env ?? process.env,
  });

  const ts = new Date().toISOString();
  console.log(`[${ts}] [CLAUDE-CLI] spawned, pid=${proc.pid}`);

  let stderr = "";
  proc.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  proc.on("close", (code) => {
    if (stderr.trim()) {
      const ts2 = new Date().toISOString();
      console.log(`[${ts2}] [CLAUDE-STDERR] exit=${code}: ${stderr.trim().slice(0, 2000)}`);
    }
  });

  return proc;
}

async function* readJsonLines(
  proc: ChildProcess,
  signal?: AbortSignal,
): AsyncGenerator<SdkMessageLike> {
  const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
  const onAbort = () => { rl.close(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  let lineCount = 0;
  try {
    for await (const line of rl) {
      if (signal?.aborted) break;
      lineCount++;
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        yield JSON.parse(trimmed) as SdkMessageLike;
      } catch { /* 非 JSON 行静默跳过 */ }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    rl.close();
    const ts = new Date().toISOString();
    console.log(`[${ts}] [CLAUDE-CLI] readJsonLines done: ${lineCount} raw lines`);
  }
}

/** 构造 stream-json 格式的 stdin 输入行 */
function buildStreamJsonInput(text: string): string {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
  }) + "\n";
}

// ---------------------------------------------------------------------------
// ClaudeAdapter
// ---------------------------------------------------------------------------

class ClaudeAdapter implements ToolAdapter {
  readonly displayName = "Claude Code";
  readonly sessionDescPrefix = "Claude Code Session:";
  private model: string;
  private effort: string;
  private subagentModel: string | undefined;
  private apiKey: string | undefined;
  private baseUrl: string | undefined;
  private isEmpty: (value: string) => boolean;
  private metaStore: ClaudeSessionMetaStore;

  constructor(options: ClaudeAdapterOptions) {
    this.model = options.model;
    this.effort = options.effort;
    this.subagentModel = options.subagentModel;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.isEmpty = options.isEmpty;
    this.metaStore = options.metaStore ?? defaultClaudeSessionMetaStore;
  }

  async createSession(cwd: string): Promise<CreateSessionResult> {
    logMcpConfig();
    const mcpConfigJson = readMcpConfigJson();
    const env = buildCliEnv(this.subagentModel, this.apiKey, this.baseUrl);
    const args = buildCliArgs(
      this.model, this.effort, this.isEmpty, mcpConfigJson,
      ["ok"],
    );

    const proc = spawnCli(args, cwd, env, false);

    for await (const msg of readJsonLines(proc)) {
      if (msg.session_id) {
        const sessionId = msg.session_id;
        await this.metaStore.set(sessionId, { cwd }).catch(() => {});
        await killProcessTree(proc.pid);
        const ts = new Date().toISOString();
        console.log(`[${ts}] [CLAUDE-CLI] createSession: ${sessionId}`);
        return { sessionId };
      }
    }

    await killProcessTree(proc.pid);
    throw new Error("No session ID in Claude init event");
  }

  async *prompt(
    sessionId: string,
    userText: string,
    cwd: string,
    signal?: AbortSignal,
    options?: ToolPromptOptions,
  ): AsyncIterable<UnifiedStreamMessage> {
    const mcpConfigJson = readMcpConfigJson();
    const env = buildCliEnv(this.subagentModel, this.apiKey, this.baseUrl);
    const args = buildCliArgs(
      this.model, this.effort, this.isEmpty, mcpConfigJson,
      ["--resume", sessionId, "--input-format", "stream-json", "--replay-user-messages"],
    );

    const proc = spawnCli(args, cwd, env, true);
    if (proc.pid !== undefined) options?.onProcessStart?.({ pid: proc.pid });

    const onAbort = () => { void killProcessTree(proc.pid); };
    signal?.addEventListener("abort", onAbort, { once: true });

    proc.stdin!.write(buildStreamJsonInput(userText));
    proc.stdin!.end();

    try {
      for await (const raw of readJsonLines(proc, signal)) {
        if (signal?.aborted) break;

        if (raw.type === "system" && raw.subtype === "init" && raw.session_id) {
          const meta: { cwd?: string; model?: string } = {};
          if (raw.cwd) meta.cwd = raw.cwd;
          if (raw.model) meta.model = raw.model;
          if (Object.keys(meta).length > 0) {
            this.metaStore.set(raw.session_id, meta).catch(() => {});
          }
        }

        const normalized = normalizeSdkMessage(raw);
        if (normalized) yield normalized;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await killProcessTree(proc.pid);
      if (proc.pid !== undefined) options?.onProcessExit?.({ pid: proc.pid });
    }
  }

  async getSessionInfo(sessionId: string): Promise<SessionInfo | undefined> {
    const meta = await this.metaStore.get(sessionId);
    if (!meta) return { sessionId };
    return meta.model
      ? { sessionId, cwd: meta.cwd, model: meta.model }
      : { sessionId, cwd: meta.cwd };
  }

  async closeSession(_sessionId: string): Promise<void> {
    // 子进程由 prompt 的 finally 自动 kill
  }
}

// ---------------------------------------------------------------------------
// 工厂函数
// ---------------------------------------------------------------------------

export function createClaudeAdapter(
  options: ClaudeAdapterOptions,
): ToolAdapter {
  return new ClaudeAdapter(options);
}