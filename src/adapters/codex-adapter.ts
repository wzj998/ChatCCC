// =============================================================================
// codex-adapter.ts — OpenAI Codex CLI 适配器（app-server 模式）
// =============================================================================
// 通过 codex app-server（WebSocket JSON-RPC）与 Codex CLI 交互。
// - createSession: 生成 UUID sessionId，记录 cwd，不创建线程（延迟到首次 prompt）
// - prompt: 首次 thread/start 创建持久化线程，后续 thread/resume 恢复；
//   运行中通过 turn/steer 在 item 边界注入新消息（协作式让位，对齐 ccc）
// - getSessionInfo: 从持久化映射读取 cwd / threadId
//
// 权限语义与旧 exec 模式 `--dangerously-bypass-approvals-and-sandbox` 等价：
//   approvalPolicy: "never" + sandbox: "danger-full-access"（demo 已实测零审批）。
// /plan、/ask 命令退化为只读沙箱（对应旧 exec 的 --sandbox read-only）。
// =============================================================================

import { createTurnCompletion } from "./turn-completion.ts";
import { ensureCliSessionReleased } from "./managed-cli-process.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type {
  ToolAdapter,
  ToolPromptOptions,
  UnifiedStreamMessage,
  CreateSessionResult,
  CodexGoalStart,
  SessionInfo,
} from "./adapter-interface.ts";
import { parseUserCommand } from "./adapter-interface.ts";
import {
  defaultCodexSessionMetaStore,
  type CodexSessionMetaStore,
} from "./codex-session-meta-store.ts";
import { config, PROJECT_ROOT } from "../config.ts";
import {
  AsyncQueue,
  CodexAppServerManager,
  JsonRpcClient,
  type CodexSandboxPolicy,
  type CodexUserInputText,
} from "./codex-app-server.ts";

// ---------------------------------------------------------------------------
// 特殊注入提示
// ---------------------------------------------------------------------------

const CODEX_SPECIFIC_PROMPT_PATH = join(
  PROJECT_ROOT,
  "agent-prompts",
  "codex_specific.md",
);

function readCodexSpecificInjectionPrompt(): string | null {
  try {
    if (!existsSync(CODEX_SPECIFIC_PROMPT_PATH)) return null;
    const prompt = readFileSync(CODEX_SPECIFIC_PROMPT_PATH, "utf-8").trim();
    return prompt.length > 0 ? prompt : null;
  } catch {
    return null;
  }
}

function buildCodexPromptText(userText: string): string {
  const prompt = readCodexSpecificInjectionPrompt();
  if (!prompt) return userText;

  return [
    "[ChatCCC Codex-specific injection prompt]",
    prompt,
    "[/ChatCCC Codex-specific injection prompt]",
    "",
    userText,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 命令与参数
// ---------------------------------------------------------------------------

/** 可通过 config.json codex.path 自定义 Codex 可执行文件路径 */
function detectCodexCommand(): string {
  return config.codex.path || "codex";
}

/** codex 模型；留空（""）表示不传，由 codex config.toml 决定 */
function resolveCodexModel(): string | null {
  const m = config.codex.model;
  return m.trim() !== "" ? m : null;
}

/** codex 努力程度；留空表示不传 */
function resolveCodexEffort(): string | null {
  const e = config.codex.effort;
  return e.trim() !== "" ? e : null;
}

// ---------------------------------------------------------------------------
// normalizeCodexNotification — app-server 通知 → UnifiedStreamMessage | null
// ---------------------------------------------------------------------------

interface CodexItem {
  type?: string;
  id?: string;
  text?: string;
  command?: string;
  aggregatedOutput?: string;
  exitCode?: number | null;
}

function itemOf(params: Record<string, unknown>): CodexItem | undefined {
  return params.item as CodexItem | undefined;
}

export function normalizeCodexNotification(
  method: string,
  params: Record<string, unknown>,
): UnifiedStreamMessage | null {
  // error 通知：willRetry=false 是致命错误；willRetry=true 会自动重试，忽略
  if (method === "error") {
    const willRetry = params.willRetry;
    const message = (params.error as { message?: string } | undefined)?.message;
    if (willRetry === false) {
      throw new Error(`Codex turn failed: ${message?.trim() || "unknown Codex error"}`);
    }
    return null;
  }

  // agentMessage 是 Codex 的一条阶段性文本 item（整段）。即使内容像完整答复，
  // 后面仍可能继续工具调用，因此不能用它关闭 response-stall watchdog。
  if (
    method === "item/completed" &&
    itemOf(params)?.type === "agentMessage" &&
    itemOf(params)?.text
  ) {
    return {
      type: "assistant",
      blocks: [{ type: "text", text: itemOf(params)!.text! }],
    };
  }

  // turn/completed 是 Codex 对整轮完成的权威确认。正文已由 agentMessage 累计。
  if (method === "turn/completed") {
    const turn = params.turn as
      | { status?: string; error?: { message?: string } | null }
      | undefined;
    if (turn?.status === "failed") {
      throw new Error(
        `Codex turn failed: ${turn.error?.message?.trim() || "unknown Codex error"}`,
      );
    }
    return {
      type: "assistant",
      blocks: [],
      isFinalResponse: true,
    };
  }

  // commandExecution 工具调用开始
  if (
    method === "item/started" &&
    itemOf(params)?.type === "commandExecution" &&
    itemOf(params)?.command
  ) {
    const item = itemOf(params)!;
    return {
      type: "assistant",
      blocks: [
        {
          type: "tool_use",
          id: item.id,
          name: "Bash",
          input: { command: item.command },
        },
      ],
    };
  }

  // commandExecution 工具调用完成
  if (method === "item/completed" && itemOf(params)?.type === "commandExecution") {
    const item = itemOf(params)!;
    const exitCode = item.exitCode;
    return {
      type: "assistant",
      blocks: [
        {
          type: "tool_result",
          tool_use_id: item.id ?? "",
          content: item.aggregatedOutput ?? "",
          is_error: exitCode != null && exitCode !== 0 ? true : undefined,
        },
      ],
    };
  }

  // thread/started、turn/started、item/agentMessage/delta 等 → 不映射为用户可见消息
  return null;
}

// ---------------------------------------------------------------------------
// 适配器实现
// ---------------------------------------------------------------------------

type GoalControl = "get" | "pause" | "clear";
type GoalCommand = { action: GoalControl } | CodexGoalStart;
type ThreadGoal = { objective?: string; status: string; tokensUsed?: number; tokenBudget?: number };

export function parseCodexGoalCommand(text: string): GoalCommand | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  const argument = match[1]?.trim() ?? "";
  const action = argument.toLowerCase();
  if (!argument) return { action: "get" };
  if (action === "pause" || action === "resume" || action === "clear") return { action };
  return { action: "set", objective: argument.replace(/^edit(?:\s+|$)/i, "") };
}

async function initializeCodexClient(client: JsonRpcClient): Promise<void> {
  await client.request("initialize", {
    clientInfo: { name: "chatccc-codex", title: null, version: "0.0.0" },
    capabilities: null,
  }, 60_000);
  client.notify("initialized");
}

function describeGoal(goal?: ThreadGoal | null): string {
  if (!goal) return "当前 Codex 线程没有目标。";
  const lines = [`Codex 目标状态：${goal.status}`];
  if (goal.objective) lines.push(goal.objective);
  if (typeof goal.tokensUsed === "number") {
    lines.push(`Token：${goal.tokensUsed}${goal.tokenBudget == null ? "" : ` / ${goal.tokenBudget}`}`);
  }
  return lines.join("\n");
}

class CodexAdapter implements ToolAdapter {
  readonly displayName = "Codex";
  readonly sessionDescPrefix = "Codex Session:";
  private metaStore: CodexSessionMetaStore;
  private modelOverride: string | undefined;
  private effortOverride: string | undefined;
  private fastModeOverride: boolean | undefined;

  constructor(
    metaStore: CodexSessionMetaStore,
    modelOverride?: string,
    effortOverride?: string,
    fastModeOverride?: boolean,
  ) {
    this.metaStore = metaStore;
    this.modelOverride = modelOverride;
    this.effortOverride = effortOverride;
    this.fastModeOverride = fastModeOverride;
  }

  // createSession: 生成 sessionId，记录 cwd，不创建线程（延迟到首次 prompt）
  async createSession(cwd: string): Promise<CreateSessionResult> {
    const sessionId = randomUUID();
    await this.metaStore.set(sessionId, { cwd });
    return { sessionId };
  }

  async controlGoal(sessionId: string, action: GoalControl): Promise<string> {
    const threadId = (await this.metaStore.get(sessionId))?.threadId;
    if (!threadId) return describeGoal();
    const port = await CodexAppServerManager.get().ensureStarted(detectCodexCommand());
    const client = await JsonRpcClient.connect(`ws://127.0.0.1:${port}`);
    try {
      await initializeCodexClient(client);
      if (action === "clear") {
        await client.request("thread/goal/clear", { threadId }, 10_000);
        return "Codex 目标已清除。";
      }
      const result = action === "pause"
        ? await client.request("thread/goal/set", { threadId, status: "paused" }, 10_000)
        : await client.request("thread/goal/get", { threadId }, 10_000);
      return describeGoal(result.goal);
    } finally {
      client.close();
    }
  }

  async *prompt(
    sessionId: string,
    userText: string,
    cwd: string,
    signal?: AbortSignal,
    options?: ToolPromptOptions,
  ): AsyncIterable<UnifiedStreamMessage> {
    if (signal?.aborted) return;
    await ensureCliSessionReleased(sessionId);
    const meta = await this.metaStore.get(sessionId);
    const threadId = meta?.threadId;
    const isFirstPrompt = !threadId;

    const cmd = parseUserCommand(userText);
    const goalCommand = options?.codexGoal;
    const readOnly = !goalCommand && cmd.mode !== null;
    if (goalCommand?.action === "set" && (!goalCommand.objective || Array.from(goalCommand.objective).length > 4_000)) {
      throw new Error("Codex 目标须包含 1–4000 个字符。");
    }
    if (goalCommand?.action === "resume" && !threadId) throw new Error("当前 Codex 线程没有可恢复的目标。");
    // thread/start 用字符串枚举；turn/start 用对象策略
    const threadSandbox = readOnly ? "read-only" : "danger-full-access";
    const turnSandboxPolicy: CodexSandboxPolicy = readOnly
      ? { type: "readOnly", networkAccess: true }
      : { type: "dangerFullAccess" };

    const model = this.modelOverride ?? resolveCodexModel();
    const effort = this.effortOverride ?? resolveCodexEffort();
    const fastMode = this.fastModeOverride ?? config.codex.fastMode;

    // 确保常驻 app-server 已启动，并建立本次 prompt 的 WebSocket 连接
    const port = await CodexAppServerManager.get().ensureStarted(detectCodexCommand());
    const client = await JsonRpcClient.connect(`ws://127.0.0.1:${port}`);

    let threadIdResolved: string | null = threadId ?? null;
    let currentTurnId: string | null = null;
    let watchingGoal = Boolean(goalCommand);
    let observedGoal: ThreadGoal | null | undefined;
    const queue = new AsyncQueue<{ method: string; params: Record<string, unknown> }>();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let idleExpired = false;
    const waitForContinuation = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleExpired = true;
        queue.end();
      }, 10_000);
    };
    client.onNotification = (method, params) => {
      if (threadIdResolved && params.threadId === threadIdResolved && method === "turn/started") {
        const id = (params.turn as { id?: string } | undefined)?.id;
        if (id) currentTurnId = id;
      }
      queue.push({ method, params });
    };
    client.onClose = () => queue.end();
    client.onServerRequest = (method, _params, id) =>
      client.respondError(id, -32000, `unexpected server request: ${method}`);

    const interruptAndClose = async (): Promise<void> => {
      if (threadIdResolved && watchingGoal) {
        try {
          await client.request("thread/goal/set", { threadId: threadIdResolved, status: "paused" }, 3000);
        } catch { /* interruption still proceeds */ }
      }
      if (threadIdResolved && currentTurnId) {
        try {
          await client.request(
            "turn/interrupt",
            { threadId: threadIdResolved, turnId: currentTurnId },
            3000,
          );
        } catch {
          /* turn 可能已结束 */
        }
      }
      client.close();
    };

    // 上层 stop-stuck-loop 强制关闭：打断当前 turn + 断开连接（不杀共享进程）
    options?.onSessionCreated?.(() => {
      void interruptAndClose().catch(() => {});
    });

    const onAbort = () => {
      void interruptAndClose().catch(() => {});
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    let completed = false;
    const completion = createTurnCompletion("Codex");

    try {
      // 1. 握手
      await initializeCodexClient(client);

      // 2. 线程：首次 thread/start 创建持久化线程，后续 thread/resume 恢复
      const threadParams = {
        cwd,
        approvalPolicy: "never",
        sandbox: threadSandbox,
        ...(model ? { model } : {}),
      };
      if (isFirstPrompt) {
        const r = await client.request("thread/start", threadParams, 60000);
        threadIdResolved = r.thread?.id as string;
        if (threadIdResolved) {
          void this.metaStore.setThreadId(sessionId, threadIdResolved).catch(() => {});
        }
      } else {
        try {
          await client.request(
            "thread/resume",
            { threadId: threadId as string, excludeTurns: true, ...threadParams },
            60000,
          );
        } catch (err) {
          if (goalCommand) throw err;
          // 存量 threadId 在磁盘上不可恢复（被清理/损坏）→ 回退到新建线程
          console.warn(
            `[Codex] thread/resume 失败，回退到新线程: ${(err as Error).message}`,
          );
          const r = await client.request("thread/start", threadParams, 60000);
          threadIdResolved = r.thread?.id as string;
          if (threadIdResolved) {
            void this.metaStore.setThreadId(sessionId, threadIdResolved).catch(() => {});
          }
        }
      }

      if (!threadIdResolved) throw new Error("Codex 未返回线程 ID。");
      if (signal?.aborted) return;
      // Setting an active goal lets app-server start the idle turn itself.
      if (goalCommand) {
        const result = await client.request("thread/goal/set", {
          threadId: threadIdResolved,
          ...(goalCommand.action === "set" ? { objective: goalCommand.objective } : {}),
          status: "active",
        }, 10_000);
        if (!result.goal) throw new Error("Codex 未返回目标状态。");
        waitForContinuation();
      } else {
        const turnResp = await client.request(
          "turn/start",
          {
            threadId: threadIdResolved,
            input: [
              { type: "text", text: buildCodexPromptText(userText), text_elements: [] },
            ] satisfies CodexUserInputText[],
            approvalPolicy: "never",
            sandboxPolicy: turnSandboxPolicy,
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
            serviceTier: fastMode ? "fast" : "default",
          },
          120000,
        );
        currentTurnId = turnResp.turn?.id as string;
      }

      // 5. 消费事件流，item 边界执行协作式注入
      for await (const { method, params } of queue) {
        if (signal?.aborted) break;
        if (typeof params.threadId === "string" && params.threadId !== threadIdResolved) continue;
        if (!readOnly && method === "thread/goal/updated") {
          observedGoal = params.goal as ThreadGoal | undefined;
          watchingGoal ||= observedGoal?.status === "active";
        }
        if (method === "thread/goal/cleared") observedGoal = null;

        // 工具步骤边界 → 检查并吸收运行期注入（turn/steer）
        if (method === "item/completed") {
          const injected = options?.drainInput?.();
          if (injected && threadIdResolved && currentTurnId) {
            try {
              const steerResp = await client.request(
                "turn/steer",
                {
                  threadId: threadIdResolved,
                  input: [{ type: "text", text: injected, text_elements: [] }],
                  expectedTurnId: currentTurnId,
                },
                30000,
              );
              currentTurnId = steerResp.turnId as string;
              yield { type: "assistant", blocks: [{ type: "input_injected", text: injected }] };
            } catch (err) {
              // steer 失败（turn 恰好已结束，expectedTurnId 前置条件不满足）
              // → 退回注入队列，交由上层在整轮结束后作为新消息消费，避免丢消息。
              console.error(
                `[Codex] turn/steer 失败，注入消息退回队列: ${(err as Error).message}`,
              );
              options?.onInjectionRejected?.();
            }
          }
        }

        // turn/started 确认当前活跃 turn id（turn/steer 后可能变化）
        if (method === "turn/started") {
          const turnId = (params.turn as { id?: string } | undefined)?.id;
          if (turnId) currentTurnId = turnId;
          clearTimeout(idleTimer);
        }

        const normalized = normalizeCodexNotification(method, params);
        completion.observe(normalized);
        if (method === "turn/completed") {
          const turn = params.turn as { id?: string; status?: string } | undefined;
          if (!turn?.id || turn.id === currentTurnId) currentTurnId = null;
          if (!readOnly && turn?.status === "completed") {
            const state = observedGoal === undefined
              ? await client.request("thread/goal/get", { threadId: threadIdResolved }, 3000)
                .catch(error => {
                  if (watchingGoal) throw error;
                  return null;
                })
              : undefined;
            const goal = observedGoal === undefined ? state?.goal as ThreadGoal | null | undefined : observedGoal;
            if (goal?.status === "active") {
              watchingGoal = true;
              waitForContinuation();
              continue;
            }
            if (watchingGoal) {
              const status: UnifiedStreamMessage = { type: "assistant", blocks: [{ type: "text", text: "\n\n" + describeGoal(goal) }] };
              completion.observe(status);
              yield status;
            }
          }
          completion.complete();
          completed = true;
        }
        if (normalized) yield normalized;
        if (completed) break;
      }

      if (!signal?.aborted && !completed && idleExpired && watchingGoal) {
        const state = await client.request("thread/goal/get", { threadId: threadIdResolved }, 3000);
        const status: UnifiedStreamMessage = { type: "assistant", blocks: [{ type: "text", text:
          "\n\n" + describeGoal(state.goal) + (state.goal?.status === "active"
            ? "\n10 秒内未收到自动续跑事件。目标仍保留，可用 /goal resume 继续。" : ""),
        }] };
        completion.observe(status);
        completion.complete();
        yield status;
        yield { type: "assistant", blocks: [], isFinalResponse: true };
        completed = true;
      }
      if (!signal?.aborted && !completed) {
        completion.assertComplete("app-server 连接在 turn 完成前关闭");
      }
    } finally {
      clearTimeout(idleTimer);
      signal?.removeEventListener("abort", onAbort);
      client.close();
    }
  }

  async getSessionInfo(sessionId: string): Promise<SessionInfo | undefined> {
    const meta = await this.metaStore.get(sessionId);
    if (!meta) return undefined;
    return { sessionId, cwd: meta.cwd };
  }

  async closeSession(_sessionId: string): Promise<void> {
    // no-op：WebSocket 连接由 prompt 的 finally 关闭；app-server 进程常驻复用
  }
}

// ---------------------------------------------------------------------------
// 工厂函数
// ---------------------------------------------------------------------------

export interface CreateCodexAdapterOptions {
  metaStore?: CodexSessionMetaStore;
  /** per-session 模型覆盖（/model 命令）；传了就用，不传走全局 codex.model */
  model?: string;
  effort?: string;
  fastMode?: boolean;
}

export function createCodexAdapter(
  options: CreateCodexAdapterOptions = {},
): CodexAdapter {
  return new CodexAdapter(
    options.metaStore ?? defaultCodexSessionMetaStore,
    options.model,
    options.effort,
    options.fastMode,
  );
}
