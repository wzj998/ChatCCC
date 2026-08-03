/**
 * progress/reducer.ts — ChatEvent 事件流 → ProgressView 的增量合并
 *
 * 这是飞书与终端共享的唯一一份"事件 → 过程视图"公共逻辑：
 * 终端 REPL 直接消费 ChatSession.chat() 的事件流，逐条 reduce；
 * 飞书侧 display loop 若未来接入事件流，同样使用本 reducer，保证两端
 * 看到的过程状态（正文累积、工具调用、终态判定）完全一致。
 */

import type { ChatEvent } from "../index.js";
import {
  withProgressView,
  type ProgressToolCall,
  type ProgressView,
} from "./view.js";

/** 工具调用 input 单行摘要（终端折叠行展示用） */
export function summarizeToolInput(input: unknown, maxChars = 120): string {
  let raw: string;
  if (typeof input === "string") {
    raw = input;
  } else {
    try {
      raw = JSON.stringify(input);
    } catch {
      raw = String(input);
    }
  }
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > maxChars ? oneLine.slice(0, maxChars) + "…" : oneLine;
}

/** 工具结果单行摘要（成功/失败各取首行） */
export function summarizeToolResult(content: unknown, maxChars = 120): string {
  let raw: string;
  if (typeof content === "string") {
    raw = content;
  } else if (content instanceof Error) {
    raw = content.message;
  } else {
    try {
      raw = JSON.stringify(content);
    } catch {
      raw = String(content);
    }
  }
  const firstLine = raw.split("\n")[0] ?? "";
  return firstLine.length > maxChars ? firstLine.slice(0, maxChars) + "…" : firstLine;
}

/**
 * 把一条 ChatEvent 合并进 ProgressView，返回新视图（不可变更新）。
 * 未识别的/不影响展示的事件（如 compact）返回原视图。
 */
export function reduceProgress(prev: ProgressView, event: ChatEvent): ProgressView {
  switch (event.type) {
    case "text":
      // accumulated 是全文累积，直接全量替换，天然幂等
      return withProgressView(prev, { text: event.accumulated });

    case "tool_use": {
      const tool: ProgressToolCall = {
        id: event.id ?? `tool-${prev.tools.length + 1}`,
        name: event.name,
        status: "running",
        detail: summarizeToolInput(event.input),
      };
      return withProgressView(prev, { tools: [...prev.tools, tool] });
    }

    case "tool_result": {
      const nextStatus = event.is_error ? ("error" as const) : ("ok" as const);
      const summary = summarizeToolResult(event.content);
      let matched = false;
      const tools = prev.tools.map((t) => {
        if (matched || t.id !== event.tool_use_id) return t;
        matched = true;
        return { ...t, status: nextStatus, summary };
      });
      if (!matched) {
        // id 缺失或失配：兜底更新最后一个 running 工具，避免状态悬挂
        const lastRunning = [...prev.tools].reverse().findIndex((t) => t.status === "running");
        if (lastRunning >= 0) {
          const idx = prev.tools.length - 1 - lastRunning;
          const updated = prev.tools.map((t, i) =>
            i === idx ? { ...t, status: nextStatus, summary } : t,
          );
          return withProgressView(prev, { tools: updated });
        }
      }
      return withProgressView(prev, { tools });
    }

    case "done":
      return withProgressView(prev, {
        status: "done",
        showStop: false,
        text: event.text,
      });

    case "error":
      return withProgressView(prev, { status: "error", showStop: false });

    case "compact":
      // 旧上下文压缩不影响当前过程展示
      return prev;
  }
}
