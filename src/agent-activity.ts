import type { UnifiedBlock } from "./adapters/adapter-interface.ts";

export type AgentActivityKind =
  | "starting"
  | "thinking"
  | "tool"
  | "processing"
  | "responding"
  | "searching"
  | "compacting";

/** The user-visible activity of a running Agent turn. */
export interface AgentActivity {
  kind: AgentActivityKind;
  /** Time when the current activity began, used for truthful elapsed time. */
  startedAt: number;
  toolName?: string;
  toolCount?: number;
}

interface ActiveTool {
  id: string;
  name: string;
  startedAt: number;
}

export interface AgentActivityTracker {
  activity: AgentActivity;
  activeTools: Map<string, ActiveTool>;
  nextAnonymousToolId: number;
}

export function createAgentActivityTracker(now = Date.now()): AgentActivityTracker {
  return {
    activity: { kind: "starting", startedAt: now },
    activeTools: new Map(),
    nextAnonymousToolId: 1,
  };
}

function sameVisibleActivity(left: AgentActivity, right: AgentActivity): boolean {
  return left.kind === right.kind
    && left.toolName === right.toolName
    && left.toolCount === right.toolCount;
}

function setActivity(tracker: AgentActivityTracker, next: AgentActivity): boolean {
  if (sameVisibleActivity(tracker.activity, next)) return false;
  tracker.activity = next;
  return true;
}

function refreshToolActivity(tracker: AgentActivityTracker): boolean {
  const tools = [...tracker.activeTools.values()];
  const first = tools[0];
  if (!first) return false;
  return setActivity(tracker, {
    kind: "tool",
    startedAt: first.startedAt,
    toolName: first.name,
    toolCount: tools.length,
  });
}

function removeCompletedTool(tracker: AgentActivityTracker, toolUseId: string): void {
  if (toolUseId && tracker.activeTools.delete(toolUseId)) return;

  // Older adapters did not always include a tool ID. Prefer an anonymous entry;
  // if there is only one active call, it is still safe to match that result.
  const anonymousId = [...tracker.activeTools.keys()].find((id) => id.startsWith("anonymous:"));
  if (anonymousId) {
    tracker.activeTools.delete(anonymousId);
  } else if (tracker.activeTools.size === 1) {
    const onlyId = tracker.activeTools.keys().next().value as string | undefined;
    if (onlyId) tracker.activeTools.delete(onlyId);
  }
}

/**
 * Applies one normalized Agent event and returns whether the persisted activity
 * changed. Tool activity takes precedence while a tool call is still active.
 */
export function updateAgentActivity(
  tracker: AgentActivityTracker,
  block: UnifiedBlock,
  now = Date.now(),
): boolean {
  if (block.type === "tool_use") {
    const id = block.id || `anonymous:${tracker.nextAnonymousToolId++}`;
    const existing = tracker.activeTools.get(id);
    tracker.activeTools.set(id, {
      id,
      name: block.name || "未知工具",
      startedAt: existing?.startedAt ?? now,
    });
    return refreshToolActivity(tracker);
  }

  if (block.type === "tool_result") {
    removeCompletedTool(tracker, block.tool_use_id);
    if (tracker.activeTools.size > 0) return refreshToolActivity(tracker);
    return setActivity(tracker, { kind: "processing", startedAt: now });
  }

  if (tracker.activeTools.size > 0) return false;

  switch (block.type) {
    case "agent_status":
      return setActivity(tracker, {
        kind: block.status === "compacting" ? "compacting" : "responding",
        startedAt: now,
      });
    case "thinking":
    case "redacted_thinking":
      return setActivity(tracker, { kind: "thinking", startedAt: now });
    case "text":
    case "text_final":
      return setActivity(tracker, { kind: "responding", startedAt: now });
    case "search_result":
      return setActivity(tracker, { kind: "searching", startedAt: now });
    case "compact_boundary":
      return setActivity(tracker, { kind: "compacting", startedAt: now });
  }
}

function formatElapsed(startedAt: number, now: number): string {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return `${totalMinutes}分${seconds}秒`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}小时${minutes}分`;
}

function displayToolName(name: string | undefined): string {
  const normalized = (name || "未知工具").replace(/\s+/g, " ").trim();
  return normalized.length > 24 ? `${normalized.slice(0, 23)}…` : normalized;
}

export function formatAgentActivityTitle(
  activity: AgentActivity | undefined,
  now = Date.now(),
): string {
  if (!activity) return "正在处理";

  let label: string;
  switch (activity.kind) {
    case "starting":
      label = "正在启动 Agent";
      break;
    case "thinking":
      label = "思考中";
      break;
    case "tool": {
      const count = Math.max(1, activity.toolCount ?? 1);
      label = `正在执行 ${displayToolName(activity.toolName)}${count > 1 ? ` 等 ${count} 项` : ""}`;
      break;
    }
    case "processing":
      label = "正在处理工具结果";
      break;
    case "responding":
      label = "正在生成回复";
      break;
    case "searching":
      label = "正在处理搜索结果";
      break;
    case "compacting":
      label = "正在整理上下文";
      break;
  }
  return `${label} · ${formatElapsed(activity.startedAt, now)}`;
}
