export const AGENT_TOOLS = ["claude", "cursor", "codex", "ccc"] as const;

export type AgentTool = typeof AGENT_TOOLS[number];

export interface AgentToolOption {
  id: AgentTool;
  label: string;
}

export const AGENT_TOOL_OPTIONS: readonly AgentToolOption[] = [
  { id: "ccc", label: "CCC" },
  { id: "claude", label: "Claude" },
  { id: "cursor", label: "Cursor" },
  { id: "codex", label: "Codex" },
];

export function isAgentTool(value: unknown): value is AgentTool {
  return typeof value === "string" && (AGENT_TOOLS as readonly string[]).includes(value);
}
