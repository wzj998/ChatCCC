import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getSessionInfo as sdkGetSessionInfo,
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  type SDKMessage,
  type SDKSession,
  type SDKSessionOptions,
  type EffortLevel,
} from "@anthropic-ai/claude-agent-sdk";

import type {
  CreateSessionResult,
  SessionInfo,
  ToolAdapter,
  ToolPromptOptions,
  UnifiedBlock,
  UnifiedStreamMessage,
} from "./adapter-interface.ts";
import { parseUserCommand } from "./adapter-interface.ts";
import { CHATCCC_PORT } from "../config.ts";
import {
  defaultClaudeSessionMetaStore,
  type ClaudeSessionMetaStore,
} from "./claude-session-meta-store.ts";

const PROJECT_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CLAUDE_SPECIFIC_PROMPT_PATH = join(
  PROJECT_ROOT,
  "agent-prompts",
  "claude_specific.md",
);

type SettingSource = "user" | "project" | "local";

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

export interface ClaudeAdapterOptions {
  model: string;
  subagentModel?: string;
  effort: string;
  apiKey?: string;
  baseUrl?: string;
  isEmpty: (value: string) => boolean;
  metaStore?: ClaudeSessionMetaStore;
  maxTurn?: number;
}

export function buildSdkEnv(
  subagentModel: string | undefined,
  apiKey: string | undefined,
  baseUrl: string | undefined,
): Record<string, string | undefined> | undefined {
  const subagentModelTrim = (subagentModel ?? "").trim();
  const apiKeyTrim = (apiKey ?? "").trim();
  const baseUrlTrim = (baseUrl ?? "").trim();

  const env: Record<string, string | undefined> = { ...process.env };
  let mutated = preferGitBashOnWindows(env);

  if (subagentModelTrim || apiKeyTrim || baseUrlTrim) {
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    delete env.ANTHROPIC_MODEL;
    delete env.ANTHROPIC_DEFAULT_OPUS_MODEL;
    delete env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    delete env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
    delete env.CLAUDE_CODE_EFFORT_LEVEL;
    delete env.CLAUDE_CODE_SUBAGENT_MODEL;
    mutated = true;
  }

  if (subagentModelTrim) env.CLAUDE_CODE_SUBAGENT_MODEL = subagentModelTrim;
  if (apiKeyTrim) env.ANTHROPIC_API_KEY = apiKeyTrim;
  if (baseUrlTrim) env.ANTHROPIC_BASE_URL = baseUrlTrim;

  return mutated ? env : undefined;
}

function preferGitBashOnWindows(env: Record<string, string | undefined>): boolean {
  if (process.platform !== "win32") return false;

  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const rawPath = env[pathKey];
  if (!rawPath) return false;

  const parts = rawPath.split(delimiter).filter((part) => part && part !== "%PATH%");
  const preferred = findPreferredGitBashPath(parts);
  if (!preferred) {
    const nextPath = parts.join(delimiter);
    if (nextPath !== rawPath) {
      env[pathKey] = nextPath;
      return true;
    }
    return false;
  }

  const preferredLower = preferred.toLowerCase();
  const reordered = [
    preferred,
    ...parts.filter((part) => part.toLowerCase() !== preferredLower),
  ];
  const nextPath = reordered.join(delimiter);
  if (nextPath === rawPath) return false;
  env[pathKey] = nextPath;
  return true;
}

function findPreferredGitBashPath(pathParts: string[]): string | undefined {
  const programFilesGit = join(
    process.env.ProgramFiles ?? "C:\\Program Files",
    "Git",
    "usr",
    "bin",
  );
  if (existsSync(join(programFilesGit, "bash.exe"))) return programFilesGit;

  return pathParts.find((part) => {
    if (!/(\\|\/)(Git)(\\|\/)usr(\\|\/)bin$/i.test(part) &&
        !/(\\|\/)Fork(\\|\/)gitInstance(\\|\/)[^\\/]+(\\|\/)bin$/i.test(part)) {
      return false;
    }
    return existsSync(join(part, "bash.exe"));
  });
}

function readMcpServersConfig(): Record<string, unknown> | undefined {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  try {
    if (!existsSync(settingsPath)) return undefined;
    const raw = readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    const mcpServers = settings.mcpServers;
    if (!mcpServers || Object.keys(mcpServers).length === 0) return undefined;
    return mcpServers;
  } catch {
    return undefined;
  }
}

function logMcpConfig(): void {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  const ts = new Date().toISOString();
  try {
    if (!existsSync(settingsPath)) {
      console.log(`[${ts}] [MCP-DIAG] settings.json not found at ${settingsPath}`);
      return;
    }
    const raw = readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    const mcpServers = settings.mcpServers;
    if (!mcpServers || Object.keys(mcpServers).length === 0) {
      console.log(`[${ts}] [MCP-DIAG] No mcpServers configured in settings.json`);
      return;
    }
    console.log(`[${ts}] [MCP-DIAG] mcpServers found: ${JSON.stringify(Object.keys(mcpServers))}`);
    for (const [name, cfg] of Object.entries(mcpServers)) {
      const item = cfg as { type?: string; command?: string; args?: string[] };
      console.log(`[${ts}] [MCP-DIAG]   ${name}: type=${item.type}, command=${item.command}, args=${JSON.stringify(item.args)}`);
    }
  } catch (err) {
    console.log(`[${ts}] [MCP-DIAG] Failed to read settings.json: ${(err as Error).message}`);
  }
}

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

export function readClaudeSpecificInjectionPrompt(): string | null {
  try {
    if (!existsSync(CLAUDE_SPECIFIC_PROMPT_PATH)) return null;
    const prompt = readFileSync(CLAUDE_SPECIFIC_PROMPT_PATH, "utf-8").trim();
    return prompt.length > 0 ? prompt : null;
  } catch {
    return null;
  }
}

export function buildClaudePromptText(
  userText: string,
  injectionPrompt: string | null = readClaudeSpecificInjectionPrompt(),
  sessionId?: string,
): string {
  let prompt = injectionPrompt?.trim();
  if (!prompt) return userText;

  // 动态替换注入提示词中的占位符（端口、session_id 等）
  if (sessionId) {
    prompt = prompt
      .replace(/\{\{stop_stuck_url\}\}/g, `http://127.0.0.1:${CHATCCC_PORT}/api/agent/stop-stuck-loop`)
      .replace(/\{\{session_id\}\}/g, sessionId);
  }

  return [
    "[ChatCCC Claude-specific injection prompt]",
    prompt,
    "[/ChatCCC Claude-specific injection prompt]",
    "",
    userText,
  ].join("\n");
}

type ClaudeSdkSessionOptions = Omit<SDKSessionOptions, "model"> & {
  model?: string;
  abortController?: AbortController;
  autoCompactEnabled?: boolean;
  effort?: EffortLevel | number;
  maxTurns?: number;
  mcpServers?: Record<string, unknown>;
  skills?: "all";
  stderr?: (data: string) => void;
};

function buildSdkOptions(args: {
  cwd: string;
  model: string;
  effort: string;
  isEmpty: (value: string) => boolean;
  subagentModel?: string;
  apiKey?: string;
  baseUrl?: string;
  maxTurn: number;
  abortController?: AbortController;
  userText: string;
}): ClaudeSdkSessionOptions {
  const {
    cwd,
    model,
    effort,
    isEmpty,
    subagentModel,
    apiKey,
    baseUrl,
    maxTurn,
    abortController,
    userText,
  } = args;

  const cmd = parseUserCommand(userText);
  const limited = cmd.mode !== null;

  const options: ClaudeSdkSessionOptions = {
    cwd,
    abortController,
    settingSources: ["user", "project", "local"] as SettingSource[],
    permissionMode: limited ? "default" : "bypassPermissions",
    autoCompactEnabled: true,
    maxTurns: maxTurn,
    skills: "all",
    ...(limited ? {
      settings: {
        permissions: {
          allow: [
            "Read",
            `Bash(curl -s -X POST http://127.0.0.1:${CHATCCC_PORT}/api/agent/stop-stuck-loop *)`,
          ],
        },
      },
    } : {}),
    stderr: (data) => {
      const trimmed = data.trim();
      if (!trimmed) return;
      const ts = new Date().toISOString();
      console.log(`[${ts}] [CLAUDE-STDERR] ${trimmed.slice(0, 2000)}`);
    },
  };

  if (!limited) {
    options.allowDangerouslySkipPermissions = true;
  }

  if (!isEmpty(model)) {
    options.model = model;
  }
  if (!isEmpty(effort)) {
    options.effort = effort as ClaudeSdkSessionOptions["effort"];
  }

  const env = buildSdkEnv(subagentModel, apiKey, baseUrl);
  if (env) {
    options.env = env;
  }

  const mcpServers = readMcpServersConfig();
  if (mcpServers) {
    options.mcpServers = mcpServers;
  }

  return options;
}

function toMessageLike(message: SDKMessage): SdkMessageLike {
  return message as unknown as SdkMessageLike;
}

function bridgeAbortSignal(
  signal: AbortSignal | undefined,
  controller: AbortController,
): (() => void) | undefined {
  if (!signal) return undefined;
  const onAbort = () => controller.abort();
  if (signal.aborted) {
    controller.abort();
    return undefined;
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function closeSdkSession(session: SDKSession): void {
  session.close();
}

function toSdkSessionOptions(options: ClaudeSdkSessionOptions): SDKSessionOptions {
  return options as SDKSessionOptions;
}

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
  private maxTurn: number;

  constructor(options: ClaudeAdapterOptions) {
    this.model = options.model;
    this.effort = options.effort;
    this.subagentModel = options.subagentModel;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.isEmpty = options.isEmpty;
    this.metaStore = options.metaStore ?? defaultClaudeSessionMetaStore;
    this.maxTurn = options.maxTurn ?? 0;
  }

  async createSession(cwd: string): Promise<CreateSessionResult> {
    logMcpConfig();
    const abortController = new AbortController();
    let sessionId: string | undefined;
    const session = unstable_v2_createSession(
      toSdkSessionOptions(buildSdkOptions({
        cwd,
        model: this.model,
        effort: this.effort,
        isEmpty: this.isEmpty,
        subagentModel: this.subagentModel,
        apiKey: this.apiKey,
        baseUrl: this.baseUrl,
        maxTurn: this.maxTurn,
        abortController,
        userText: "",
      })),
    );

    try {
      await session.send("ok");
      for await (const raw of session.stream()) {
        const msg = toMessageLike(raw);
        if (msg.session_id && !sessionId) {
          sessionId = msg.session_id;
          await this.metaStore.set(sessionId, {
            cwd: msg.cwd ?? cwd,
            model: msg.model,
          }).catch(() => {});
          const ts = new Date().toISOString();
          console.log(`[${ts}] [CLAUDE-SDK] createSession: ${sessionId}`);
        }
      }
    } finally {
      closeSdkSession(session);
    }

    if (sessionId) return { sessionId };
    throw new Error("No session ID in Claude init event");
  }

  async *prompt(
    sessionId: string,
    userText: string,
    cwd: string,
    signal?: AbortSignal,
    options?: ToolPromptOptions,
  ): AsyncIterable<UnifiedStreamMessage> {
    const abortController = new AbortController();
    const removeAbortListener = bridgeAbortSignal(signal, abortController);
    if (abortController.signal.aborted) return;
    let aborted = false;

    const session = unstable_v2_resumeSession(
      sessionId,
      toSdkSessionOptions(buildSdkOptions({
        cwd,
        model: this.model,
        effort: this.effort,
        isEmpty: this.isEmpty,
        subagentModel: this.subagentModel,
        apiKey: this.apiKey,
        baseUrl: this.baseUrl,
        maxTurn: this.maxTurn,
        abortController,
        userText,
      })),
    );

    options?.onSessionCreated?.(() => session.close());

    try {
      await session.send(buildClaudePromptText(userText, undefined, sessionId));
      for await (const raw of session.stream()) {
        if (abortController.signal.aborted) {
          aborted = true;
          break;
        }

        const msg = toMessageLike(raw);
        if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
          const meta: { cwd?: string; model?: string } = {};
          if (msg.cwd) meta.cwd = msg.cwd;
          if (msg.model) meta.model = msg.model;
          if (Object.keys(meta).length > 0) {
            this.metaStore.set(msg.session_id, meta).catch(() => {});
          }
        }

        const normalized = normalizeSdkMessage(msg);
        if (normalized) yield normalized;
      }
    } finally {
      removeAbortListener?.();
      if (aborted || abortController.signal.aborted) {
        abortController.abort();
      }
      closeSdkSession(session);
    }
  }

  async getSessionInfo(sessionId: string): Promise<SessionInfo | undefined> {
    const meta = await this.metaStore.get(sessionId);

    try {
      const sdkInfo = await sdkGetSessionInfo(
        sessionId,
        meta?.cwd ? { dir: meta.cwd } : undefined,
      );
      if (sdkInfo) {
        return {
          sessionId: sdkInfo.sessionId,
          cwd: sdkInfo.cwd ?? meta?.cwd,
          summary: sdkInfo.summary,
          lastModified: sdkInfo.lastModified,
          model: meta?.model,
        };
      }
    } catch {
      // Fall back to the local meta store below.
    }

    if (!meta) return { sessionId };
    return meta.model
      ? { sessionId, cwd: meta.cwd, model: meta.model }
      : { sessionId, cwd: meta.cwd };
  }

  async closeSession(_sessionId: string): Promise<void> {
    // SDK query streams are request scoped and are closed in prompt/createSession.
  }
}

export function createClaudeAdapter(
  options: ClaudeAdapterOptions,
): ToolAdapter {
  return new ClaudeAdapter(options);
}
