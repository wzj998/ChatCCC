import type { PlatformAdapter } from "../../platform-adapter.ts";
import { resumeAndPrompt, stopSession } from "../../session.ts";
import { isSessionRunning } from "../../session-chat-binding.ts";
import { readStreamState } from "../../stream-state.ts";
import type { TaskExecutionRuntime } from "../application/task-execution-service.ts";

export function createTaskExecutionRuntime(platform: PlatformAdapter): TaskExecutionRuntime {
  return {
    async run(input) {
      const outcome = await resumeAndPrompt(
        input.sessionId,
        input.prompt,
        platform,
        input.chatId,
        Date.now(),
        input.agentId,
        input.traceId,
      );
      const stream = await readStreamState(input.sessionId);
      if (outcome === "busy") {
        return { outcome: "error", error: "Main Agent session became busy before the task started" };
      }
      return {
        outcome,
        ...(stream?.transcript?.length ? { transcript: stream.transcript } : {}),
        ...(stream?.finalReply ? { result: stream.finalReply } : {}),
        ...(stream?.terminalError?.message ? { error: stream.terminalError.message } : {}),
      };
    },
    async getSnapshot(sessionId) {
      const state = await readStreamState(sessionId);
      return {
        transcript: state?.transcript ?? [],
        ...(state?.updatedAt ? { updatedAt: new Date(state.updatedAt).toISOString() } : {}),
        ...(state?.status ? { status: state.status } : {}),
      };
    },
    stop: stopSession,
    isSessionRunning,
  };
}
