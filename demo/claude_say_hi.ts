/**
 * 命令行通过 Claude Agent SDK 说「你好」，并把流式正文打印到 stdout。
 *
 *   .\node_modules\.bin\tsx.cmd demo/claude_say_hi.ts
 *   npm run demo:claude-hi
 */

import { createClaudeAdapter } from "../src/adapters/claude-adapter.ts";
import {
  CLAUDE_EFFORT,
  CLAUDE_MODEL,
  getDefaultCwd,
  isAnthropicConfigEmpty,
} from "../src/config.ts";

async function main(): Promise<void> {
  const cwd = await getDefaultCwd();
  console.error(`[claude_say_hi] cwd=${cwd}`);

  const adapter = createClaudeAdapter({
    model: CLAUDE_MODEL,
    effort: CLAUDE_EFFORT,
    isEmpty: isAnthropicConfigEmpty,
  });

  const { sessionId } = await adapter.createSession(cwd);
  console.error(`[claude_say_hi] session_id=${sessionId}`);

  let printedReply = false;
  for await (const msg of adapter.prompt(sessionId, "你好", cwd)) {
    for (const block of msg.blocks) {
      if (block.type === "text" && "text" in block) {
        process.stdout.write(block.text);
        printedReply = true;
      }
    }
  }

  if (printedReply) process.stdout.write("\n");
  else console.error("[claude_say_hi] 流结束但未收到 assistant text 块");
}

main().catch((err) => {
  console.error("[claude_say_hi] 失败:", err);
  process.exitCode = 1;
});
