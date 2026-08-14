import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  CreateSessionResult,
  SessionInfo,
  ToolAdapter,
  ToolPromptOptions,
  UnifiedBlock,
  UnifiedStreamMessage,
} from "./adapter-interface.ts";
import { engineManager } from "../engines/engine-specs.ts";
import { config, RAW_STREAM_LOGS_DIR } from "../config.ts";
import { createRawStreamLog, type RawStreamLogHandle } from "./raw-stream-log.ts";

interface DshNotification {
  method: string;
  params: Record<string, unknown>;
}

interface DshRunResult {
  sessionId: string;
  finalResponse: string;
}

interface DshHarness {
  start(): Promise<void>;
  run(input: string, options: { sessionId: string; onNotification: (notification: DshNotification) => void }): Promise<DshRunResult>;
  close(): Promise<void>;
}

interface DshSdkModule {
  DeepSeekHarness: new (options: unknown) => DshHarness;
}

export interface DshAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  subModel?: string;
  provider?: string;
  maxTokens?: number;
}

let injectedSdk: DshSdkModule | null = null;
const knownSessions = new Map<string, SessionInfo>();

export function __setDshSdkModuleForTest(module: DshSdkModule | null): void {
  injectedSdk = module;
}

export function createDshAdapter(options: DshAdapterOptions = {}): ToolAdapter {
  // DSH 引擎的 JSON-RPC `session/prompt` 只支持 create、不支持 resume：已持久化的
  // session 必须在同一个 runtime 进程内复用，否则第二次 prompt 会因 "id collision"
  // 失败（新 runtime 内存里没有该 session，走 create 路径与磁盘 log 冲突）。
  // 因此这里按 sessionId 缓存长驻 runtime，正常完成不关闭，close/abort/崩溃时关闭。
  const runtimes = new Map<string, { harness: DshHarness; cwd: string }>();

  const disposeRuntime = (sessionId: string): void => {
    const entry = runtimes.get(sessionId);
    if (!entry) return;
    runtimes.delete(sessionId);
    void entry.harness.close().catch(() => {});
  };

  return {
    displayName: "DeepSeek Harness",
    sessionDescPrefix: "DSH Session:",
    responseStallDetectionEnabled: true,

    async createSession(cwd: string): Promise<CreateSessionResult> {
      await engineManager.getEntryPath("dsh");
      const sessionId = `dsh-${randomUUID()}`;
      knownSessions.set(sessionId, { sessionId, cwd, lastModified: Date.now(), model: options.model ?? "deepseek-v4-flash" });
      return { sessionId };
    },

    async *prompt(
      sessionId: string,
      userText: string,
      cwd: string,
      signal?: AbortSignal,
      promptOptions?: ToolPromptOptions,
    ): AsyncIterable<UnifiedStreamMessage> {
      const entryPath = await engineManager.getEntryPath("dsh");
      const installationDir = resolve(dirname(entryPath), "../../../..");
      const sdk = injectedSdk ?? await import(pathToFileURL(entryPath).href) as unknown as DshSdkModule;
      const sessionRoot = join(homedir(), ".chatccc", "dsh-sessions");
      await mkdir(sessionRoot, { recursive: true });

      // 复用长驻 runtime：同一 session 的多次 prompt 必须在同一 runtime 进程内完成
      // （DSH 的 session/prompt 无 resume 能力，见上方 runtimes 注释）。cwd 变化时
      // 重建（旧 runtime 已绑定旧 cwd，无法切换工作目录）。
      let entry = runtimes.get(sessionId);
      if (!entry || entry.cwd !== cwd) {
        if (entry) disposeRuntime(sessionId);
        const runtime = new sdk.DeepSeekHarness({
          launch: {
            command: process.execPath,
            args: [
              join(installationDir, "node_modules", "@deepseek-ai", "dsh-sdk-jsonrpc-demo", "lib", "bin.js"),
              join(installationDir, "dsh-runtime.cordis.yml"),
            ],
            cwd,
            env: {
              ...process.env,
              DSH_CWD: cwd,
              DSH_SESSION_ROOT: sessionRoot,
              ...(options.apiKey ? { DEEPSEEK_API_KEY: options.apiKey } : {}),
              ...(options.baseUrl ? { DEEPSEEK_BASE_URL: options.baseUrl } : {}),
              // 子代理模型：subModel 留空时跟随主模型（与 CCC 的 ccc.subModel 语义一致）
              DSH_SUBAGENT_PROVIDER: options.provider ?? "deepseek-official",
              DSH_SUBAGENT_MODEL: options.subModel || options.model || "deepseek-v4-flash",
              DSH_SUBAGENT_MAX_TOKENS: String(options.maxTokens ?? 49152),
            },
          },
          cwd,
          provider: options.provider ?? "deepseek-official",
          model: options.model ?? "deepseek-v4-flash",
          ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
        });
        entry = { harness: runtime, cwd };
        runtimes.set(sessionId, entry);
      }
      const runtime = entry.harness;

      const queue = new AsyncMessageQueue();
      const rawLogConfig = config.rawStreamLogs.dsh;
      let rawLog: RawStreamLogHandle | null = null;
      try {
        rawLog = await createRawStreamLog({
          enabled: rawLogConfig.enabled,
          rootDir: RAW_STREAM_LOGS_DIR,
          tool: "dsh",
          sessionId,
          label: "prompt",
          maxBytesPerTurn: rawLogConfig.maxBytesPerTurn,
          retentionDays: rawLogConfig.retentionDays,
        });
      } catch (error) {
        console.error(`[DSH raw stream log] create failed: ${(error as Error).message}`);
      }
      let completed = false;
      // abort / stop-stuck 时关闭该 session 的 runtime 以中止进行中的请求；
      // 正常完成不关闭，保留 runtime 供同一 session 的后续 prompt 复用。
      promptOptions?.onSessionCreated?.(() => disposeRuntime(sessionId));
      const onAbort = (): void => disposeRuntime(sessionId);
      signal?.addEventListener("abort", onAbort, { once: true });

      const task = (async () => {
        try {
          await runtime.start();
          // DSH 引擎在 LLM 调用失败时不会让 run() reject：错误被写进 turn/end 事件
          // 的 reason（kind="error"）后，session 进入 idle，run() 返回空 finalResponse。
          // 这里把第一个 turn 错误收集起来，run() 结束后重新抛出，交给 session.ts
          // 的统一终态错误分类与脱敏展示，避免飞书里"静默失败"。
          let turnError: Error | null = null;
          const result = await runtime.run(userText, {
            sessionId,
            onNotification: (notification) => {
              rawLog?.writeLine(JSON.stringify(notification));
              turnError ??= extractTurnError(notification);
              const message = notificationToMessage(notification);
              if (message) queue.push(message);
            },
          });
          if (result.finalResponse) {
            rawLog?.writeLine(JSON.stringify({ type: "run.result", result }));
            queue.push({ type: "assistant", blocks: [{ type: "text_final", text: result.finalResponse }], isFinalResponse: true });
            completed = true;
          } else if (turnError) {
            queue.fail(turnError);
          } else {
            // 引擎正常结束但零输出（无错误、无回复）：给出明确提示，避免用户只看到"失败"。
            queue.push({
              type: "assistant",
              blocks: [{ type: "text_final", text: "DeepSeek Harness 本轮未产生任何回复（引擎未报告错误）。" }],
              isFinalResponse: true,
            });
            completed = true;
          }
          if (completed) {
            knownSessions.set(sessionId, { sessionId, cwd, lastModified: Date.now(), model: options.model ?? "deepseek-v4-flash" });
            queue.end();
          }
        } catch (error) {
          // runtime 崩溃 / 传输关闭 / id collision 等：关闭并移除，下次 prompt 重建。
          // 注意：DSH 无 resume 能力，重启 ChatCCC 后磁盘残留同 id log 会再次 id collision；
          // 这里附加清晰的用户提示，引导 /forget 清空会话而非静默失败。
          disposeRuntime(sessionId);
          const failure = error instanceof Error ? error : new Error(String(error));
          if (/id collision/i.test(failure.message)) {
            queue.fail(new Error(
              `${failure.message}。该 DeepSeek Harness 会话的历史无法跨进程恢复（引擎的 JSON-RPC 仅支持 create 不支持 resume），请使用 /forget 清空本会话或新建会话后重试。`,
            ));
          } else {
            queue.fail(failure);
          }
        } finally {
          signal?.removeEventListener("abort", onAbort);
          await rawLog?.close({ keep: rawLogConfig.keepCompleted || signal?.aborted === true || !completed });
        }
      })();

      try {
        for await (const message of queue) yield message;
        await task;
      } finally {
        // 正常完成保留 runtime 供复用；abort 已在 onAbort 中 dispose。
      }
    },

    async getSessionInfo(sessionId: string): Promise<SessionInfo | undefined> {
      return knownSessions.get(sessionId) ?? { sessionId };
    },

    async closeSession(sessionId: string): Promise<void> {
      disposeRuntime(sessionId);
    },
  };
}

/**
 * 从 DSH 引擎的 session.event 里提取第一个 turn/end 错误。
 *
 * DSH 引擎（dsh-agent-loop）在 turn 失败时把错误持久化到 `turn/end` 事件的
 * `data.reason`（`{ kind: "error", error: { message, code, status? } }`），随后
 * `kick()` 吞掉该错误并让 session 进入 idle。SDK 的 `run()` 因此正常返回空
 * `finalResponse`，而不是 reject。此函数把该错误还原成 Error，供 prompt()
 * 重新抛出，复用 session.ts 的统一终态错误分类（401/429/网络等）与脱敏。
 */
function extractTurnError(notification: DshNotification): Error | null {
  if (notification.method !== "session.event") return null;
  const event = asRecord(notification.params.event);
  if (!event || event.type !== "turn/end") return null;
  const data = asRecord(event.data);
  const reason = asRecord(data?.reason);
  if (!reason || reason.kind !== "error") return null;
  const failure = asRecord(reason.error);
  const code = typeof failure?.code === "string" ? failure.code : "";
  const status = typeof failure?.status === "number" ? `HTTP ${failure.status}` : "";
  const message = typeof failure?.message === "string" ? failure.message : "";
  const detail = [status, code ? `[${code}]` : "", message].filter(Boolean).join(" ").trim();
  return new Error(detail || "DeepSeek Harness 引擎报告了未提供详情的执行错误");
}

function notificationToMessage(notification: DshNotification): UnifiedStreamMessage | null {
  if (notification.method === "session.status") {
    return notification.params.status === "running"
      ? { type: "system", blocks: [{ type: "agent_status", status: "responding" }] }
      : null;
  }
  if (notification.method === "subagent.started") {
    return { type: "system", blocks: [{ type: "agent_progress", phase: "reasoning" }] };
  }
  if (notification.method !== "session.event") return null;
  const event = asRecord(notification.params.event);
  if (!event) return null;
  const data = asRecord(event.data);
  if (!data) return null;
  const blocks: UnifiedBlock[] = [];

  if (event.type === "assistant/chunk") {
    const chunk = asRecord(data.chunk);
    if (chunk?.type === "text-delta" && typeof chunk.text === "string" && chunk.text) {
      blocks.push({ type: "text", text: chunk.text });
    }
  } else if (event.type === "tool/call") {
    const raw = typeof data.arguments === "string" ? data.arguments : "{}";
    let input: unknown = raw;
    try { input = JSON.parse(raw); } catch { /* retain raw provider arguments */ }
    blocks.push({
      type: "tool_use",
      ...(typeof data.callId === "string" ? { id: data.callId } : {}),
      name: typeof data.name === "string" ? data.name : "tool",
      input,
    });
  } else if (event.type === "tool/result") {
    const message = asRecord(data.message);
    const callId = typeof message?.toolCallId === "string"
      ? message.toolCallId
      : typeof message?.callId === "string"
        ? message.callId
        : "";
    blocks.push({
      type: "tool_result",
      tool_use_id: callId,
      content: message?.content ?? data.message,
      ...(data.error ? { is_error: true } : {}),
    });
  } else if (event.type === "turn/start" || event.type === "step/start") {
    blocks.push({ type: "agent_progress", phase: "reasoning" });
  }

  return blocks.length ? { type: "assistant", blocks } : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

class AsyncMessageQueue implements AsyncIterable<UnifiedStreamMessage> {
  private readonly values: UnifiedStreamMessage[] = [];
  private readonly waiters: Array<() => void> = [];
  private done = false;
  private error: Error | null = null;

  push(value: UnifiedStreamMessage): void {
    if (this.done) return;
    this.values.push(value);
    this.waiters.shift()?.();
  }

  end(): void {
    this.done = true;
    while (this.waiters.length) this.waiters.shift()?.();
  }

  fail(error: Error): void {
    this.error = error;
    this.end();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<UnifiedStreamMessage> {
    while (true) {
      if (this.values.length) {
        yield this.values.shift()!;
        continue;
      }
      if (this.error) throw this.error;
      if (this.done) return;
      await new Promise<void>((resolvePromise) => this.waiters.push(resolvePromise));
    }
  }
}
