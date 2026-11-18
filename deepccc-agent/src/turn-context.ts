import type { ModelMessage, ToolResultPart } from "ai";
import { compactJsonValue, type ToolArgumentPreserver } from "./tool-argument-replay.js";
import { instructionPath } from "./instruction-replay.js";

export const DEFAULT_STEP_TOOL_CONTEXT_CHARS = 96_000;
export const DEFAULT_STEP_TOOL_RESULT_CHARS = 24_000;
export const DEFAULT_STEP_RECENT_RESULTS = 4;
export const DEFAULT_STEP_TOOL_INPUT_CHARS = 64_000;
export const DEFAULT_STEP_INSTRUCTION_CHARS = 32_000;
const OMITTED = "[earlier tool result omitted from subsequent model steps to keep this turn within its context budget; rerun a focused read/search if still needed]";
const TRUNCATED = "...[tool result shortened for subsequent model steps]...";

export interface CompactToolLoopOptions {
  maxToolChars?: number;
  maxResultChars?: number;
  keepRecentResults?: number;
  maxToolInputChars?: number;
  maxInstructionChars?: number;
  preserveToolArgument?: ToolArgumentPreserver;
}
export interface CompactToolLoopResult {
  messages: ModelMessage[];
  originalToolChars: number;
  retainedToolChars: number;
  compactedResults: number;
  originalInputChars: number;
  retainedInputChars: number;
  compactedInputs: number;
  retainedInstructionResults: number;
  retainedExecutionSummaries: number;
}

function serialized(value: unknown): string {
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

function excerpt(value: string, maximum: number, marker: string): string {
  if (value.length <= maximum) return value;
  const available = Math.max(0, maximum - marker.length);
  const head = Math.ceil(available * 0.6);
  const tail = Math.max(0, available - head);
  return value.slice(0, head) + marker + (tail ? value.slice(-tail) : "");
}

function shortened(output: ToolResultPart["output"], maximum: number): ToolResultPart["output"] {
  const raw = serialized(output);
  if (raw.length <= maximum) return output;
  let allowance = Math.max(0, maximum - 40);
  // Escaping happens again when the excerpt is serialized into a model message.
  for (let attempt = 0; attempt < 12; attempt++) {
    const result: ToolResultPart["output"] = { type: "text", value: excerpt(raw, allowance, TRUNCATED) };
    const size = serialized(result).length;
    if (size <= maximum) return result;
    allowance = Math.max(0, allowance - Math.max(1, size - maximum));
  }
  return { type: "text", value: "[output omitted; reread evidence]" };
}

function recordValue(output: ToolResultPart["output"]): Record<string, unknown> | undefined {
  let value: unknown = "value" in output ? output.value : undefined;
  if (typeof value === "string" && value.trim().startsWith("{")) {
    try { value = JSON.parse(value); } catch { return; }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function executionSummary(output: ToolResultPart["output"]): { output: ToolResultPart["output"]; failed: boolean } | undefined {
  const value = recordValue(output);
  const failed = output.type === "error-text" || output.type === "error-json"
    || value?.timedOut === true || value?.is_error === true
    || (typeof value?.exitCode === "number" && value.exitCode !== 0);
  if (!failed && (!value || !("exitCode" in value || "taskId" in value || "running" in value))) return;
  const summary: Record<string, string | number | boolean | null> = {
    contextSummary: true, executionFailed: failed, originalOutputChars: serialized(output).length,
    outputOmitted: true,
    notice: "Output body is not retained here; inspect saved artifacts before claiming it was read.",
  };
  if (value) {
    for (const key of ["exitCode", "signal", "timedOut", "running", "backgrounded", "taskId", "cwd", "command"]) {
      const item = value[key];
      if (typeof item === "string") summary[key] = excerpt(item, 600, "...[omitted]...");
      else if (item === null || typeof item === "number" || typeof item === "boolean") summary[key] = item;
    }
    if (failed && typeof value.stderr === "string") summary.stderr = excerpt(value.stderr, 1200, "...[stderr omitted]...");
    if (failed && typeof value.error === "string") summary.error = excerpt(value.error, 600, "...[error omitted]...");
  } else if ("value" in output) summary.error = excerpt(serialized(output.value), 1200, "...[error omitted]...");
  return { output: { type: "json", value: summary }, failed };
}

/** Preserve argument keys/types, while trimming oversized historical string values. */
function shortenedInput(input: unknown, maximum: number, preserveArgument?: ToolArgumentPreserver): unknown {
  return compactJsonValue(input, maximum, false, preserveArgument);
}

/** Changes only a model-facing clone, never executed calls or persisted history. */
export function compactToolLoopMessages(
  input: readonly ModelMessage[],
  options: CompactToolLoopOptions = {},
): CompactToolLoopResult {
  const maximum = Math.max(1_000, options.maxToolChars ?? DEFAULT_STEP_TOOL_CONTEXT_CHARS);
  const perResult = Math.max(500, options.maxResultChars ?? DEFAULT_STEP_TOOL_RESULT_CHARS);
  const keepRecent = Math.max(0, Math.floor(options.keepRecentResults ?? DEFAULT_STEP_RECENT_RESULTS));
  const messages = structuredClone(input) as ModelMessage[];
  const callInstructions = new Map<string, ReturnType<typeof instructionPath>>();
  const calls: Array<{ part: { input: unknown }; original: number }> = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "tool-call") continue;
      if (part.toolName === "read_file") callInstructions.set(part.toolCallId, instructionPath(part.input));
      calls.push({ part, original: serialized(part.input).length });
    }
  }
  const originalInputChars = calls.reduce((sum, call) => sum + call.original, 0);
  const inputMaximum = Math.max(1_000, options.maxToolInputChars ?? DEFAULT_STEP_TOOL_INPUT_CHARS);
  if (originalInputChars > inputMaximum) {
    const olderCount = Math.max(0, calls.length - keepRecent);
    const recentSize = calls.slice(olderCount).reduce((sum, call) => sum + Math.min(16_000, call.original), 0);
    const olderCap = Math.max(256, Math.min(4_000, Math.floor(Math.max(0, inputMaximum - recentSize) / Math.max(1, olderCount))));
    calls.forEach((call, index) => { call.part.input = shortenedInput(call.part.input, index < olderCount ? olderCap : 16_000, options.preserveToolArgument); });
  }

  const refs: Array<{ message: Extract<ModelMessage, { role: "tool" }>; partIndex: number;
    part: ToolResultPart; original: number; instruction: ReturnType<typeof instructionPath>;
    status: ReturnType<typeof executionSummary>; superseded: boolean }> = [];
  for (const message of messages) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const [partIndex, part] of message.content.entries()) {
      if (part.type !== "tool-result") continue;
      refs.push({ message, partIndex, part, original: serialized(part.output).length,
        instruction: callInstructions.get(part.toolCallId), status: executionSummary(part.output), superseded: false });
    }
  }
  const latestInstruction = new Map<string, number>();
  refs.forEach((item, index) => { if (item.instruction) latestInstruction.set(item.instruction.key, index); });
  refs.forEach((item, index) => { item.superseded = !!item.instruction && latestInstruction.get(item.instruction.key) !== index; });
  let omitted: ToolResultPart["output"] = { type: "text", value: OMITTED };
  if (refs.length * serialized(omitted).length > maximum / 2) omitted = { type: "text", value: "[earlier output omitted; reread focused evidence]" };
  if (refs.length * serialized(omitted).length > maximum) omitted = { type: "text", value: "[omitted]" };
  if (refs.length * serialized(omitted).length > maximum) {
    throw new Error("Too many tool results for this context budget; checkpoint and start a new turn");
  }
  const outputs: ToolResultPart["output"][] = refs.map(item => item.superseded
    ? { type: "text", value: "[superseded instruction read omitted; use the later read of this same file]" }
    : omitted);
  let retainedToolChars = outputs.reduce((sum, output) => sum + serialized(output).length, 0);
  if (retainedToolChars > maximum) {
    outputs.forEach((_, index) => { outputs[index] = omitted; });
    retainedToolChars = outputs.reduce((sum, output) => sum + serialized(output).length, 0);
  }
  const selected = new Set<number>();
  const restore = (index: number, desired: ToolResultPart["output"], limit = maximum): boolean => {
    const before = serialized(outputs[index]).length;
    const available = Math.min(limit, maximum - retainedToolChars + before);
    if (available < 100 && serialized(desired).length > available) return false;
    const output = serialized(desired).length <= available ? desired : shortened(desired, available);
    const size = serialized(output).length;
    if (size > available) return false;
    outputs[index] = output;
    retainedToolChars += size - before;
    selected.add(index);
    return true;
  };
  refs.forEach((item, index) => {
    if (!item.superseded && item.original <= serialized(outputs[index]).length) restore(index, item.part.output);
  });
  let instructionSpent = 0;
  const lastMessage = messages.at(-1);
  const freshIds = new Set(lastMessage?.role === "tool" && Array.isArray(lastMessage.content)
    ? lastMessage.content.filter(part => part.type === "tool-result").map(part => part.toolCallId) : []);
  const instructionBudget = Math.min(options.maxInstructionChars ?? DEFAULT_STEP_INSTRUCTION_CHARS, Math.floor(maximum / 2));
  const instructionIndices = [...latestInstruction.values()].sort((a, b) =>
    Number(refs[b].instruction?.primary) - Number(refs[a].instruction?.primary) || b - a);
  for (const index of instructionIndices) {
    if (selected.has(index) || refs[index].status?.failed) continue;
    const allowance = Math.min(freshIds.has(refs[index].part.toolCallId) ? instructionBudget : perResult,
      instructionBudget - instructionSpent);
    if (allowance < 100) continue;
    if (restore(index, refs[index].part.output, allowance)) instructionSpent += serialized(outputs[index]).length;
  }
  // The latest tool batch has not yet been read by the next model step. Keep
  // complete fresh results when the aggregate budget allows; perResult is a
  // historical retention limit, not an unconditional first-display truncator.
  for (let index = refs.length - 1; index >= 0; index--) {
    if (!selected.has(index) && !refs[index].superseded && freshIds.has(refs[index].part.toolCallId)) {
      restore(index, refs[index].part.output);
    }
  }
  for (let index = refs.length - 1; index >= 0; index--) {
    if (!selected.has(index) && !refs[index].superseded && refs[index].status?.failed) restore(index, refs[index].status!.output);
  }
  for (let index = Math.max(0, refs.length - keepRecent); index < refs.length; index++) {
    if (!selected.has(index) && !refs[index].superseded) restore(index, refs[index].part.output, perResult);
  }
  for (let index = refs.length - keepRecent - 1; index >= 0; index--) {
    if (selected.has(index) || refs[index].superseded) continue;
    const desired = shortened(refs[index].part.output, perResult);
    if (serialized(desired).length - serialized(outputs[index]).length <= maximum - retainedToolChars) restore(index, desired);
    else if (refs[index].status) restore(index, refs[index].status!.output);
  }
  refs.forEach((item, index) => { item.message.content[item.partIndex] = { ...item.part, output: outputs[index] }; });
  return {
    messages,
    originalToolChars: refs.reduce((sum, item) => sum + item.original, 0),
    retainedToolChars,
    compactedResults: refs.filter((item, index) => serialized(item.part.output) !== serialized(outputs[index])).length,
    originalInputChars,
    retainedInputChars: calls.reduce((sum, call) => sum + serialized(call.part.input).length, 0),
    compactedInputs: calls.filter(call => serialized(call.part.input).length !== call.original).length,
    retainedInstructionResults: instructionIndices.filter(index => selected.has(index) && !refs[index].status?.failed).length,
    retainedExecutionSummaries: refs.filter((item, index) => selected.has(index) && item.status
      && serialized(item.part.output) !== serialized(outputs[index])).length,
  };
}
