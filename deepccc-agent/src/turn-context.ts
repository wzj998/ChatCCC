import type { ModelMessage, ToolResultPart } from "ai";

export const DEFAULT_STEP_TOOL_CONTEXT_CHARS = 96_000;
export const DEFAULT_STEP_TOOL_RESULT_CHARS = 24_000;
export const DEFAULT_STEP_RECENT_RESULTS = 4;
const OMITTED = "[earlier tool result omitted from subsequent model steps to keep this turn within its context budget; rerun a focused read/search if still needed]";
const TRUNCATED = "...[tool result shortened for subsequent model steps]...";

export interface CompactToolLoopOptions {
  maxToolChars?: number;
  maxResultChars?: number;
  keepRecentResults?: number;
}
export interface CompactToolLoopResult {
  messages: ModelMessage[];
  originalToolChars: number;
  retainedToolChars: number;
  compactedResults: number;
}

function serialized(output: ToolResultPart["output"]): string {
  try { return JSON.stringify(output); } catch { return String(output); }
}

function shortened(output: ToolResultPart["output"], maximum: number): ToolResultPart["output"] {
  const raw = serialized(output);
  if (raw.length <= maximum) return output;
  const available = Math.max(0, maximum - TRUNCATED.length - 2);
  const head = Math.ceil(available * 0.6);
  const tail = Math.max(0, available - head);
  return { type: "text", value: `${raw.slice(0, head)}${TRUNCATED}${tail ? raw.slice(-tail) : ""}` };
}

/** Bound tool payload replayed by the AI SDK between steps of one turn. */
export function compactToolLoopMessages(
  input: readonly ModelMessage[],
  options: CompactToolLoopOptions = {},
): CompactToolLoopResult {
  const maximum = Math.max(1_000, options.maxToolChars ?? DEFAULT_STEP_TOOL_CONTEXT_CHARS);
  const perResult = Math.max(500, options.maxResultChars ?? DEFAULT_STEP_TOOL_RESULT_CHARS);
  const keepRecent = Math.max(0, options.keepRecentResults ?? DEFAULT_STEP_RECENT_RESULTS);
  const messages = structuredClone(input) as ModelMessage[];
  const refs: Array<{ message: number; part: number; original: number }> = [];
  for (let message = 0; message < messages.length; message += 1) {
    const item = messages[message];
    if (item.role !== "tool" || !Array.isArray(item.content)) continue;
    for (let part = 0; part < item.content.length; part += 1) {
      const content = item.content[part];
      if (content.type !== "tool-result") continue;
      refs.push({ message, part, original: serialized(content.output).length });
    }
  }
  const originalToolChars = refs.reduce((sum, ref) => sum + ref.original, 0);
  let retainedToolChars = 0;
  let compactedResults = 0;
  const omittedOutput: ToolResultPart["output"] = { type: "text", value: OMITTED };
  const omittedSize = serialized(omittedOutput).length;
  const recentCount = Math.min(keepRecent, refs.length);
  const olderCount = refs.length - recentCount;
  const recentCap = recentCount > 0
    ? Math.max(500, Math.min(perResult, Math.floor(Math.max(0, maximum - olderCount * omittedSize) / recentCount)))
    : perResult;
  const prepared = refs.map((ref, index) => {
    const message = messages[ref.message];
    if (message.role !== "tool" || !Array.isArray(message.content)) return null;
    const part = message.content[ref.part];
    if (part.type !== "tool-result") return null;
    const recent = index >= refs.length - keepRecent;
    const capped = shortened(part.output, recent ? recentCap : perResult);
    return { message, partIndex: ref.part, part, capped, cappedSize: serialized(capped).length, recent };
  }).filter((item): item is NonNullable<typeof item> => item !== null);
  // Start from the smallest protocol-valid representation, protecting the most
  // recent results (still capped individually), then spend remaining budget on
  // older evidence from newest to oldest.
  for (const item of prepared) {
    const output = item.recent ? item.capped : omittedOutput;
    item.message.content[item.partIndex] = { ...item.part, output };
    retainedToolChars += item.recent ? item.cappedSize : omittedSize;
    if (serialized(item.part.output) !== serialized(output)) compactedResults += 1;
  }
  for (let index = prepared.length - keepRecent - 1; index >= 0; index -= 1) {
    const item = prepared[index];
    const delta = item.cappedSize - omittedSize;
    if (delta <= 0 || retainedToolChars + delta > maximum) continue;
    item.message.content[item.partIndex] = { ...item.part, output: item.capped };
    retainedToolChars += delta;
    if (serialized(item.part.output) !== serialized(omittedOutput)) compactedResults -= 1;
    if (serialized(item.part.output) !== serialized(item.capped)) compactedResults += 1;
  }
  return { messages, originalToolChars, retainedToolChars, compactedResults };
}
