import { resolve } from "node:path";

import { sessionPrefixForTool, toolDisplayName, ts } from "./config.ts";
import { setDefaultCwd } from "./config.ts";
import type { PlatformAdapter } from "./platform-adapter.ts";
import { initClaudeSession, recordSessionRegistry, resumeAndPrompt, saveSessionTool } from "./session.ts";
import { bindChatToSession } from "./session-chat-binding.ts";
import { sessionChatName } from "./session-name.ts";

export interface DelegateAgentTaskInput {
  platform: PlatformAdapter;
  tool: string;
  cwd: string;
  promptText: string;
  openIds: string[];
  chatNamePrefix?: string;
  msgTimestamp?: number;
  traceId?: string;
}

export interface DelegateAgentTaskResult {
  chatId: string;
  sessionId: string;
  tool: string;
  cwd: string;
}

export async function delegateAgentTask(input: DelegateAgentTaskInput): Promise<DelegateAgentTaskResult> {
  const cwd = resolve(input.cwd);
  const toolLabel = toolDisplayName(input.tool);
  const init = await initClaudeSession(input.tool, cwd);
  const sessionId = init.sessionId;
  const chatNamePrefix = input.chatNamePrefix?.trim() || input.promptText.slice(0, 10) || "新会话";
  const chatName = sessionChatName(chatNamePrefix, cwd);

  let chatId: string;
  try {
    chatId = await input.platform.createGroup(chatName, input.openIds);
    await input.platform.updateChatInfo(chatId, chatName, `${sessionPrefixForTool(input.tool)} ${sessionId}`);
    await setDefaultCwd(cwd, chatId);
    bindChatToSession(sessionId, chatId);
    await recordSessionRegistry({
      chatId,
      sessionId,
      tool: input.tool,
      chatName,
      turnCount: 0,
      startTime: Date.now(),
      running: false,
    });
    await saveSessionTool(sessionId, input.tool, chatName);
  } catch (err) {
    console.error(`[${ts()}] [AGENT-DELEGATE-TASK] create group failed: ${(err as Error).message}`);
    throw err;
  }

  await input.platform.sendCard(
    chatId,
    `${toolLabel} Session Ready`,
    `已创建 **${toolLabel}** 会话群。\n\n` +
      `**Session ID:** ${sessionId}\n` +
      `**工作目录:** \`${cwd}\`\n\n` +
      `下面会自动把任务作为第一句话发送给 ${toolLabel}。`,
    "green",
  ).catch(() => {});
  input.platform.setChatAvatar(chatId, input.tool, "new").catch(() => {});

  await resumeAndPrompt(
    sessionId,
    input.promptText,
    input.platform,
    chatId,
    input.msgTimestamp ?? Date.now(),
    input.tool,
    input.traceId,
  );

  console.log(`[${ts()}] [AGENT-DELEGATE-TASK] created ${toolLabel} session=${sessionId} chat=${chatId} cwd=${cwd}`);
  return { chatId, sessionId, tool: input.tool, cwd };
}

