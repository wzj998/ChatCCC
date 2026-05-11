/**
 * 命令行对 Claude Agent SDK 说「你好」，并把流式正文打印到 stdout。
 *
 *   .\node_modules\.bin\tsx.cmd demo/claude_say_hi.ts
 *   npm run demo:claude-hi
 */

import { unstable_v2_createSession } from "@anthropic-ai/claude-agent-sdk";

import {
  CLAUDE_EFFORT,
  CLAUDE_MODEL,
  getDefaultCwd,
  isAnthropicConfigEmpty,
} from "../src/config.ts";

function claudeSdkSessionOptions(cwd: string): Record<string, unknown> {
  const o: Record<string, unknown> = {
    cwd,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    autoCompactEnabled: true,
  };
  if (!isAnthropicConfigEmpty(CLAUDE_MODEL)) o.model = CLAUDE_MODEL;
  if (!isAnthropicConfigEmpty(CLAUDE_EFFORT)) o.effort = CLAUDE_EFFORT;
  return o;
}

async function main(): Promise<void> {
  const cwd = await getDefaultCwd();
  console.error(`[claude_say_hi] cwd=${cwd}`);

  const session = unstable_v2_createSession(claudeSdkSessionOptions(cwd) as any);
  try {
    await session.send("你好");
    const stream = session.stream();
    let printedReply = false;

    let loggedSessionId = false;
    for await (const msg of stream) {
      const m = msg as {
        session_id?: string;
        type?: string;
        message?: { content?: Array<{ type: string; thinking?: string; text?: string }> };
      };

      // 每条流事件都可能带 session_id，不能 continue，否则会丢掉同条里的 assistant 正文
      if (m.session_id && !loggedSessionId) {
        console.error(`[claude_say_hi] session_id=${m.session_id}`);
        loggedSessionId = true;
      }

      if ((m.type === "assistant" || m.type === "user") && m.message?.content) {
        for (const block of m.message.content) {
          if (block.type === "text" && block.text) {
            process.stdout.write(block.text);
            printedReply = true;
          }
        }
      }
    }

    if (printedReply) process.stdout.write("\n");
    else console.error("[claude_say_hi] 流结束但未收到 assistant text 块（可检查 SDK 事件结构是否变化）");
  } finally {
    session.close();
  }
}

main().catch((err) => {
  console.error("[claude_say_hi] 失败:", err);
  process.exitCode = 1;
});
