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
      let closed = false;
      let completed = false;
      const closeRuntime = (): void => {
        if (closed) return;
        closed = true;
        void runtime.close();
      };
      promptOptions?.onSessionCreated?.(closeRuntime);
      const onAbort = (): void => closeRuntime();
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
          queue.fail(error instanceof Error ? error : new Error(String(error)));
        } finally {
          signal?.removeEventListener("abort", onAbort);
          await runtime.close().catch(() => {});
          await rawLog?.close({ keep: rawLogConfig.keepCompleted || signal?.aborted === true || !completed });
          closed = true;
        }
      })();

      try {
        for await (const message of queue) yield message;
        await task;
      } finally {
        closeRuntime();
      }
    },

    async getSessionInfo(sessionId: string): Promise<SessionInfo | undefined> {
      return knownSessions.get(sessionId) ?? { sessionId };
    },

    async closeSession(): Promise<void> {
      // Each prompt owns and closes its runtime. Durable state lives under ~/.chatccc/dsh-sessions.
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
