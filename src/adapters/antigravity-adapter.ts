import { spawn } from "node:child_process";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { client, methods, ndJsonStream, PROTOCOL_VERSION, type SessionUpdate } from "@agentclientprotocol/sdk";

import { ANTIGRAVITY_SESSION_PREFIX, USER_DATA_DIR } from "../config.ts";
import { parseUserCommand, type ToolAdapter, type ToolPromptOptions, type UnifiedBlock } from "./adapter-interface.ts";
import { AsyncQueue } from "./codex-app-server.ts";
import { createCursorSessionMetaStore, type CursorSessionMetaStore } from "./cursor-session-meta-store.ts";
import { cliProcessOptions, ensureCliSessionReleased, ownCliProcess } from "./managed-cli-process.ts";

const sessionStore = createCursorSessionMetaStore(join(USER_DATA_DIR, "state", "antigravity-session-meta.json"));
const { agent, client: acpClient } = methods;
const running = new Map<string, () => Promise<void>>();

interface AntigravityOptions {
  enabled?: boolean;
  path?: string;
  store?: CursorSessionMetaStore;
}

function toBlock(update: SessionUpdate): UnifiedBlock | undefined {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      if (update.content.type === "text") return { type: "text", text: update.content.text };
      break;
    case "agent_thought_chunk":
      return { type: "agent_progress", phase: "reasoning" };
    case "tool_call":
      return { type: "tool_use", id: update.toolCallId, name: update.title, input: update.rawInput };
    case "tool_call_update":
      if (update.status === "completed" || update.status === "failed") {
        return {
          type: "tool_result",
          tool_use_id: update.toolCallId,
          content: update.rawOutput ?? update.content ?? [],
          is_error: update.status === "failed",
        };
      }
      break;
  }
}

export function createAntigravityAdapter({
  enabled = false,
  path = "agy",
  store = sessionStore,
}: AntigravityOptions = {}): ToolAdapter {
  function connect(
    cwd: string,
    signal?: AbortSignal,
    onUpdate?: (sessionId: string, update: SessionUpdate) => void,
    sessionId?: string,
    options?: ToolPromptOptions,
  ) {
    signal?.throwIfAborted();
    if (!enabled) throw new Error("请在 ChatCCC 配置中启用 antigravity.enabled。");
    if (!process.env.GEMINI_API_KEY?.trim()) {
      throw new Error("请在启动 ChatCCC 的环境中设置 GEMINI_API_KEY。");
    }

    const proc = spawn(path, ["acp", "--sandbox"], {
      ...cliProcessOptions(),
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const ownership = ownCliProcess(sessionId ?? `agy-create:${proc.pid}`, proc.pid);
    const processInfo = proc.pid ? { pid: proc.pid } : undefined;

    // 聊天平台未实现 ACP 审批交互。保留 CLI 权限检查，取消需要用户确认的操作。
    const connection = client({ name: "ChatCCC" })
      .onRequest(acpClient.session.requestPermission, () => ({ outcome: { outcome: "cancelled" } }))
      .onNotification(acpClient.session.update, ({ params }) => onUpdate?.(params.sessionId, params.update))
      .connect(ndJsonStream(
        Writable.toWeb(proc.stdin),
        Readable.toWeb(proc.stdout) as unknown as ReadableStream<Uint8Array>,
      ));
    proc.stderr.resume();

    const stop = async () => {
      connection.close();
      await ownership.stop();
      proc.stdin.destroy();
      proc.stdout.destroy();
      proc.stderr.destroy();
    };
    const abort = () => { void stop().catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    proc.on("error", (error) => connection.close(error));
    if (processInfo) options?.onProcessStart?.(processInfo);

    return {
      peer: connection.agent,
      async initialize() {
        const result = await connection.agent.request(agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        if (result.protocolVersion !== PROTOCOL_VERSION || !result.agentCapabilities?.sessionCapabilities?.resume) {
          throw new Error("当前 agy 版本不支持 ACP 会话恢复，请更新 Antigravity CLI。");
        }
        await connection.agent.request(agent.authenticate, { methodId: "gemini-api-key" });
      },
      async dispose() {
        signal?.removeEventListener("abort", abort);
        await stop();
        if (processInfo) options?.onProcessExit?.(processInfo);
      },
      stop,
    };
  }

  return {
    displayName: "Antigravity CLI",
    sessionDescPrefix: ANTIGRAVITY_SESSION_PREFIX,

    async createSession(cwd, signal) {
      const connection = connect(cwd, signal);
      try {
        await connection.initialize();
        const { sessionId } = await connection.peer.request(agent.session.new, { cwd, mcpServers: [] });
        await store.set(sessionId, { cwd });
        return { sessionId };
      } finally {
        await connection.dispose();
      }
    },

    async *prompt(sessionId, userText, cwd, signal, options) {
      await ensureCliSessionReleased(sessionId);
      if (running.has(sessionId)) throw new Error("Antigravity 会话仍在执行。");
      const updates = new AsyncQueue<UnifiedBlock>();
      let prompting = false;
      const connection = connect(cwd, signal, (id, update) => {
        if (!prompting || id !== sessionId) return;
        const block = toBlock(update);
        if (block) updates.push(block);
      }, sessionId, options);
      running.set(sessionId, connection.stop);

      try {
        await connection.initialize();
        const resumed = await connection.peer.request(agent.session.resume, { sessionId, cwd, mcpServers: [] });
        const { mode } = parseUserCommand(userText);
        const modeId = mode ? "plan" : "default";
        const availableMode = resumed.modes?.availableModes.some((entry) => entry.id === modeId);
        if (mode && !availableMode) throw new Error("Antigravity 当前会话未提供 plan 模式。");
        if (availableMode && resumed.modes?.currentModeId !== modeId) {
          await connection.peer.request(agent.session.setMode, { sessionId, modeId });
        }
        prompting = true;

        const completion = connection.peer.request(agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: userText }],
        }).then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        ).finally(() => updates.end());

        for await (const block of updates) {
          signal?.throwIfAborted();
          yield { type: "assistant", blocks: [block] };
        }
        const outcome = await completion;
        if ("error" in outcome) throw outcome.error;
        if (outcome.result.stopReason !== "end_turn") {
          throw new Error(`Antigravity 提前结束会话（${outcome.result.stopReason}）。`);
        }
      } finally {
        try {
          await connection.dispose();
        } finally {
          running.delete(sessionId);
        }
      }
    },

    async getSessionInfo(sessionId) {
      const meta = await store.get(sessionId);
      return meta ? { sessionId, ...meta } : undefined;
    },

    async closeSession(sessionId) {
      await running.get(sessionId)?.();
    },
  };
}
