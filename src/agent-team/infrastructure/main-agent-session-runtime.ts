import type { AgentTool } from "../../agent-tool.ts";
import { sessionPrefixForTool, setDefaultCwd } from "../../config.ts";
import type { PlatformAdapter } from "../../platform-adapter.ts";
import { isSessionRunning } from "../../session-chat-binding.ts";
import {
  initClaudeSession,
  recordChatPlatform,
  switchChatBinding,
} from "../../session.ts";
import type { MainAgentSessionRuntime } from "../application/main-agent-service.ts";

export function createMainAgentSessionRuntime(platform: PlatformAdapter): MainAgentSessionRuntime {
  return {
    createSession(agentId: AgentTool, cwd: string) {
      return initClaudeSession(agentId, cwd);
    },

    isSessionRunning,

    async bindSession(input) {
      const description = `${sessionPrefixForTool(input.agentId)} ${input.newSessionId}`;
      const result = await switchChatBinding({
        chatId: input.chatId,
        chatType: "group",
        oldSessionId: input.oldSessionId,
        newSessionId: input.newSessionId,
        tool: input.agentId,
        chatName: input.chatName,
        namePolicy: "fixed",
        newDescription: description,
        updateChatInfoFn: (chatId, name, nextDescription) =>
          platform.updateChatInfo(chatId, name, nextDescription),
      });
      if (!result.ok) throw result.error ?? new Error("Failed to bind main Agent session");
      await setDefaultCwd(input.cwd, input.chatId);
      recordChatPlatform(input.chatId, platform);
      await platform.setChatAvatar(input.chatId, input.agentId, "new").catch(() => {});
    },
  };
}
