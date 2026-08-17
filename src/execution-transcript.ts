import type { UnifiedBlock } from "./adapters/adapter-interface.ts";

export type ExecutionTranscriptEntryType =
  | "prompt"
  | "thinking"
  | "text"
  | "tool_use"
  | "tool_result"
  | "search"
  | "compact"
  | "status"
  | "notice";

/** A provider-neutral, lossless-enough record of one visible Agent execution event. */
export interface ExecutionTranscriptEntry {
  type: ExecutionTranscriptEntryType;
  at: string;
  text?: string;
  name?: string;
  toolUseId?: string;
  input?: string;
  output?: string;
  isError?: boolean;
}

export interface ExecutionTranscriptState {
  transcript: ExecutionTranscriptEntry[];
}

export function appendExecutionTranscriptBlock(
  block: UnifiedBlock,
  state: ExecutionTranscriptState,
  at = new Date().toISOString(),
): void {
  switch (block.type) {
    case "text_reset":
      state.transcript = [];
      return;
    case "text":
      appendText(state, block.text, at);
      return;
    case "text_final":
      // Some adapters emit both deltas and an authoritative final snapshot. Keep the
      // ordered deltas when present, otherwise retain the snapshot as the full reply.
      if (!state.transcript.some((entry) => entry.type === "text")) appendText(state, block.text, at);
      return;
    case "thinking":
      appendEntry(state, { type: "thinking", at, text: block.thinking });
      return;
    case "tool_use":
      appendEntry(state, {
        type: "tool_use",
        at,
        name: block.name,
        ...(block.id ? { toolUseId: block.id } : {}),
        input: stringifyTranscriptValue(block.input),
      });
      return;
    case "tool_result":
      appendEntry(state, {
        type: "tool_result",
        at,
        ...(findToolName(state.transcript, block.tool_use_id) ? { name: findToolName(state.transcript, block.tool_use_id) } : {}),
        toolUseId: block.tool_use_id,
        output: stringifyTranscriptValue(block.content),
        ...(block.is_error !== undefined ? { isError: block.is_error } : {}),
      });
      return;
    case "search_result":
      appendEntry(state, { type: "search", at, text: block.query });
      return;
    case "compact_boundary":
      appendEntry(state, {
        type: "compact",
        at,
        text: `${block.trigger === "manual" ? "手动" : "自动"}压缩：${block.pre_tokens} → ${block.post_tokens ?? "?"} tokens`,
      });
      return;
    case "agent_status": {
      const text = block.status === "compacting" ? "正在压缩上下文" : "正在生成回复";
      const previous = state.transcript.at(-1);
      if (previous?.type !== "status" || previous.text !== text) appendEntry(state, { type: "status", at, text });
      return;
    }
    case "redacted_thinking":
      appendEntry(state, { type: "notice", at, text: "部分思考内容已被安全过滤" });
      return;
    case "agent_progress":
      // Heartbeats carry no content and can occur very frequently. Persisting them
      // would add noise without helping users reconstruct what happened.
      return;
  }
}

export function isExecutionTranscriptEntry(value: unknown): value is ExecutionTranscriptEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<ExecutionTranscriptEntry>;
  const types: ExecutionTranscriptEntryType[] = [
    "prompt", "thinking", "text", "tool_use", "tool_result", "search", "compact", "status", "notice",
  ];
  if (!types.includes(entry.type as ExecutionTranscriptEntryType) || typeof entry.at !== "string") return false;
  for (const field of ["text", "name", "toolUseId", "input", "output"] as const) {
    if (entry[field] !== undefined && typeof entry[field] !== "string") return false;
  }
  return entry.isError === undefined || typeof entry.isError === "boolean";
}

function findToolName(entries: ExecutionTranscriptEntry[], toolUseId: string): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type === "tool_use" && entry.toolUseId === toolUseId) return entry.name;
  }
  return undefined;
}

function appendText(state: ExecutionTranscriptState, text: string, at: string): void {
  if (!text) return;
  const previous = state.transcript.at(-1);
  if (previous?.type === "text") {
    previous.text = (previous.text ?? "") + text;
    return;
  }
  appendEntry(state, { type: "text", at, text });
}

function appendEntry(state: ExecutionTranscriptState, entry: ExecutionTranscriptEntry): void {
  state.transcript.push(entry);
}

function stringifyTranscriptValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
