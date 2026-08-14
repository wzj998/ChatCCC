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
          const result = await runtime.run(userText, {
            sessionId,
            onNotification: (notification) => {
              rawLog?.writeLine(JSON.stringify(notification));
              const message = notificationToMessage(notification);
              if (message) queue.push(message);
            },
          });
          if (result.finalResponse) {
            rawLog?.writeLine(JSON.stringify({ type: "run.result", result }));
            queue.push({ type: "assistant", blocks: [{ type: "text_final", text: result.finalResponse }], isFinalResponse: true });
          }
          completed = true;
          knownSessions.set(sessionId, { sessionId, cwd, lastModified: Date.now(), model: options.model ?? "deepseek-v4-flash" });
          queue.end();
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
