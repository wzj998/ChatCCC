import type { UnifiedStreamMessage } from "./adapter-interface.ts";
import { sanitizeTerminalErrorDetail } from "../terminal-error.ts";

/** Protocol output (init, echo, heartbeat, tools) is not a successful reply. */
export function createTurnCompletion(tool: string) {
  let hasReply = false;
  let completed = false;
  return {
    observe(message: UnifiedStreamMessage | null) {
      for (const block of message?.blocks ?? []) {
        if (block.type === "text_reset") hasReply = false;
        if (message?.type === "assistant" && (block.type === "text" || block.type === "text_final") && block.text.trim()) hasReply = true;
      }
    },
    complete() {
      if (!hasReply) throw new Error(`${tool} 本轮未产生有效回复（收到结束事件，但回复为空）。`);
      completed = true;
    },
    assertComplete(detail = "") {
      if (!completed) throw new Error(`${tool} 未正常完成：输出流结束但未收到成功完成事件${detail ? `；${sanitizeTerminalErrorDetail(detail)}` : ""}。`);
    },
  };
}
