import type { JSONValue, ModelMessage, ToolResultPart } from "ai";

export function instructionPath(input: unknown): { key: string; primary: boolean } | undefined {
  if (!input || typeof input !== "object") return;
  const path = (input as { path?: unknown }).path;
  if (typeof path !== "string") return;
  const normalized = path.replace(/\\/g, "/").replace(/\/\.\//g, "/");
  if (!/(?:^|\/)skills\/.+\/(?:SKILL\.md|references\/.+\.md)$/i.test(normalized)) return;
  return { key: /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized,
    primary: /\/SKILL\.md$/i.test(normalized) };
}

type Call = { id: string; key: string; sequence: number; input: unknown };
type Entry = Call & { output: ToolResultPart["output"] };

/** Retains actual tool evidence in this session, independently of bounded history. */
export class InstructionReplayCache {
  private sequence = 0;
  private calls = new Map<string, Call>();
  private observed = new Set<string>();
  private latest = new Map<string, Entry>();

  observeCall(id: string, name: string, input: unknown): void {
    if (name !== "read_file" || this.calls.has(id)) return;
    const path = instructionPath(input);
    if (!path) return;
    this.calls.set(id, { id, key: path.key, sequence: ++this.sequence, input: structuredClone(input) });
  }

  observeOutput(id: string, output: ToolResultPart["output"]): void {
    const call = this.calls.get(id);
    if (!call || this.observed.has(id)) return;
    this.observed.add(id);
    const old = this.latest.get(call.key);
    if (old && old.sequence > call.sequence) return;
    this.latest.delete(call.key);
    this.latest.set(call.key, { ...call, output: structuredClone(output) });
    // Bound the number of full read results; the model-facing text budget is
    // still applied by compactToolLoopMessages after restoration.
    if (this.latest.size > 32) this.latest.delete(this.latest.keys().next().value!);
  }

  observeFileResult(id: string, value: unknown): void {
    if (!this.calls.has(id)) return;
    const json = JSON.stringify(value);
    this.observeOutput(id, json === undefined
      ? { type: "text", value: "[instruction read returned no output; reload the file]" }
      : { type: "json", value: JSON.parse(json) as JSONValue });
  }

  observeError(id: string, error: string): void {
    this.observeOutput(id, { type: "error-text", value: error });
  }

  capture(messages: readonly ModelMessage[]): void {
    for (const message of messages) {
      if (!Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (message.role === "assistant" && part.type === "tool-call") {
          this.observeCall(part.toolCallId, part.toolName, part.input);
        } else if (message.role === "tool" && part.type === "tool-result") {
          this.observeOutput(part.toolCallId, part.output);
        }
      }
    }
  }

  restore(input: readonly ModelMessage[]): ModelMessage[] {
    const messages = structuredClone(input) as ModelMessage[];
    for (const message of messages) {
      if (!Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (part.type !== "tool-call" && part.type !== "tool-result") continue;
        const call = this.calls.get(part.toolCallId);
        const current = call && this.latest.get(call.key);
        if (!current) continue;
        if (message.role === "assistant" && part.type === "tool-call" && current.id === part.toolCallId) {
          part.input = structuredClone(current.input);
        } else if (message.role === "tool" && part.type === "tool-result") {
          part.output = current.id === part.toolCallId
            ? structuredClone(current.output)
            : { type: "text", value: "[superseded instruction read omitted; reload current skill before relying on it]" };
        }
      }
    }
    return messages;
  }
}
