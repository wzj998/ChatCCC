import { spawn } from "node:child_process";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

import { ANTIGRAVITY_SESSION_PREFIX, DEFAULT_ANTIGRAVITY_MODEL, USER_DATA_DIR } from "../config.ts";
import { sanitizeTerminalErrorDetail } from "../terminal-error.ts";
import { parseUserCommand, type ToolAdapter, type ToolPromptOptions } from "./adapter-interface.ts";
import { createCursorSessionMetaStore, type CursorSessionMetaStore } from "./cursor-session-meta-store.ts";
import { readJsonLinesWithBadJsonIdleWatchdog } from "./jsonl-stream.ts";
import { cliProcessOptions, ensureCliSessionReleased, ownCliProcess } from "./managed-cli-process.ts";

const sessionStore = createCursorSessionMetaStore(join(USER_DATA_DIR, "state", "antigravity-session-meta.json"));
const running = new Map<string, () => Promise<void>>();
const displayName = "Antigravity CLI";
const modelAlias = "chatccc-gemini";

interface AntigravityOptions {
  enabled?: boolean;
  path?: string;
  model?: string;
  store?: CursorSessionMetaStore;
}

interface HeadlessEvent {
  event: string;
  step_update?: {
    step_index: number;
    step_type: string;
    state: string;
    text_delta?: string;
    tool_info?: { name: string; parameters?: unknown; output?: unknown; error?: unknown };
  };
  result?: { status: string; response?: string; error?: string };
}

export function createAntigravityAdapter({
  enabled = false,
  path = "agy",
  model = DEFAULT_ANTIGRAVITY_MODEL,
  store = sessionStore,
}: AntigravityOptions = {}): ToolAdapter {
  function checkReady(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (!enabled) throw new Error("请在 ChatCCC 配置中启用 antigravity.enabled。");
    if (!process.env.GEMINI_API_KEY?.trim()) {
      throw new Error("请在启动 ChatCCC 的环境中设置 GEMINI_API_KEY。");
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(model)) {
      throw new Error("antigravity.model 必须是 Gemini API 模型 ID，例如 gemini-3.1-flash-lite。");
    }
  }

  function launch(args: string[], cwd: string, sessionId?: string, options?: ToolPromptOptions) {
    const proc = spawn(path, args, {
      ...cliProcessOptions(),
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const ownership = ownCliProcess(sessionId ?? `agy-create:${proc.pid}`, proc.pid);
    const processInfo = proc.pid ? { pid: proc.pid } : undefined;
    if (processInfo) options?.onProcessStart?.(processInfo);
    return { proc, ownership, processInfo };
  }

  return {
    displayName,
    sessionDescPrefix: ANTIGRAVITY_SESSION_PREFIX,

    async createSession(cwd, signal) {
      checkReady(signal);
      const { proc, ownership } = launch(["acp", "--sandbox"], cwd);
      const { agent, client: acpClient } = methods;
      const connection = client({ name: "ChatCCC" })
        .onRequest(acpClient.session.requestPermission, () => ({ outcome: { outcome: "cancelled" } }))
        .connect(ndJsonStream(
          Writable.toWeb(proc.stdin),
          Readable.toWeb(proc.stdout) as unknown as ReadableStream<Uint8Array>,
        ));
      proc.stderr.resume();
      proc.on("error", (error) => connection.close(error));
      const stop = () => {
        connection.close();
        return ownership.stop();
      };
      const abort = () => { void stop().catch(() => {}); };
      signal?.addEventListener("abort", abort, { once: true });

      try {
        const result = await connection.agent.request(agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        if (result.protocolVersion !== PROTOCOL_VERSION) {
          throw new Error("当前 agy 版本不支持 ACP，请更新 Antigravity CLI。");
        }
        await connection.agent.request(agent.authenticate, { methodId: "gemini-api-key" });
        const { sessionId } = await connection.agent.request(agent.session.new, { cwd, mcpServers: [] });
        await store.set(sessionId, { cwd, model });
        return { sessionId };
      } finally {
        signal?.removeEventListener("abort", abort);
        await stop();
      }
    },

    async *prompt(sessionId, userText, cwd, signal, options) {
      await ensureCliSessionReleased(sessionId);
      if (running.has(sessionId)) throw new Error("Antigravity 会话仍在执行。");
      checkReady(signal);

      // ACP 负责创建空会话。Headless 支持自定义 Gemini API 模型，并能用同一会话 ID 续聊。
      const settings = {
        modelProvider: "gemini",
        agentMode: "",
        customModelsConfig: {
          customModels: { [modelAlias]: { modelName: `gemini-api://${model}`, label: model } },
        },
      };
      const { mode } = parseUserCommand(userText);
      const { proc, ownership, processInfo } = launch([
        "--settings", JSON.stringify(settings),
        "--model", modelAlias,
        "--sandbox",
        "--conversation", sessionId,
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--disable-slash-commands",
        ...(mode ? ["--mode", "plan"] : []),
      ], cwd, sessionId, options);

      const stop = () => ownership.stop();
      running.set(sessionId, stop);
      const abort = () => { void stop().catch(() => {}); };
      signal?.addEventListener("abort", abort, { once: true });
      let stderr = "";
      let spawnError: Error | undefined;
      proc.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
      proc.on("error", (error) => { spawnError = error; });
      proc.stdin.on("error", (error) => { spawnError ??= error; });
      const exit = new Promise<number | null>((resolve) => proc.once("close", resolve));
      proc.stdin.end(JSON.stringify({ event: "user", message: { content: userText } }) + "\n");

      try {
        let result: HeadlessEvent["result"];
        let streamedText = false;
        const toolStarts = new Set<number>();
        for await (const event of readJsonLinesWithBadJsonIdleWatchdog<HeadlessEvent>({
          input: proc.stdout, tool: displayName, signal,
        })) {
          if (event.event === "result") result = event.result;
          const step = event.step_update;
          if (event.event !== "step_update" || !step) continue;
          if (step.step_type === "agent_response" && step.text_delta) {
            streamedText = true;
            yield { type: "assistant", blocks: [{ type: "text", text: step.text_delta }] };
          }
          if (step.step_type === "tool" && step.tool_info) {
            const { name, parameters, output, error } = step.tool_info;
            const id = String(step.step_index);
            if (!toolStarts.has(step.step_index)) {
              toolStarts.add(step.step_index);
              yield { type: "assistant", blocks: [{ type: "tool_use", id, name, input: parameters }] };
            }
            if (step.state === "DONE") {
              yield { type: "user", blocks: [{
                type: "tool_result", tool_use_id: id, content: error ?? output ?? "", is_error: !!error,
              }] };
            }
          }
        }
        signal?.throwIfAborted();
        const exitCode = await exit;
        signal?.throwIfAborted();
        if (exitCode !== 0 || result?.status !== "SUCCESS") {
          const detail = sanitizeTerminalErrorDetail(result?.error || spawnError?.message || stderr);
          throw new Error(`Antigravity 使用 ${model} 执行失败${detail ? `：${detail}` : "：未收到成功结束事件。"}`);
        }
        if (result.response?.trim()) {
          yield { type: "assistant", isFinalResponse: true, blocks: [{ type: "text_final", text: result.response }] };
        } else if (!streamedText) {
          throw new Error("Antigravity 本轮未产生有效回复。");
        }
      } finally {
        signal?.removeEventListener("abort", abort);
        try {
          await stop();
          if (processInfo) options?.onProcessExit?.(processInfo);
        } finally {
          running.delete(sessionId);
        }
      }
    },

    async getSessionInfo(sessionId) {
      const meta = await store.get(sessionId);
      return meta ? { sessionId, ...meta, model } : undefined;
    },

    async closeSession(sessionId) {
      await running.get(sessionId)?.();
    },
  };
}
