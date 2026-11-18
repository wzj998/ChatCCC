import { createHash } from "node:crypto";
import type { ModelMessage, ToolResultPart } from "ai";

export interface ModelToolView {
  tool_call_id: string;
  name: string;
  original_output_sha256: string;
  model_output_sha256: string;
  original_output_chars: number;
  model_output_chars: number;
  changed: boolean;
  content: ToolResultPart["output"];
}

function resultParts(messages: readonly ModelMessage[]): ToolResultPart[] {
  return messages.flatMap(message => message.role === "tool" && Array.isArray(message.content)
    ? message.content.filter((part): part is ToolResultPart => part.type === "tool-result") : []);
}
function hash(text: string): string { return createHash("sha256").update(text, "utf8").digest("hex"); }

/** Exact prepared model-facing tool outputs, not a claim of semantic reading. */
export function modelToolViews(original: readonly ModelMessage[], prepared: readonly ModelMessage[]): ModelToolView[] {
  const originals = new Map(resultParts(original).map(part => [part.toolCallId, part]));
  return resultParts(prepared).flatMap(part => {
    const before = originals.get(part.toolCallId);
    if (!before) return [];
    const source = JSON.stringify(before.output), model = JSON.stringify(part.output);
    return [{ tool_call_id: part.toolCallId, name: part.toolName,
      original_output_sha256: hash(source), model_output_sha256: hash(model),
      original_output_chars: source.length, model_output_chars: model.length,
      changed: source !== model, content: structuredClone(part.output) }];
  });
}
