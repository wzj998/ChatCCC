export function cwdDisplayName(cwd: string): string {
  const trimmed = cwd.trim().replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).filter(Boolean).pop() || trimmed || "cwd";
}

export function sessionChatName(left: string, cwd: string): string {
  return `${left}-${cwdDisplayName(cwd)}`;
}

/** Derive a deterministic user-facing title without changing the IM chat name. */
export function sessionDisplayTitleFromPrompt(prompt: string, maxLength = 32): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (!normalized) return "新会话";
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

export function normalizeSessionDisplayTitle(value: string, maxLength = 80): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error("会话名称不能为空");
  if (normalized.length > maxLength) throw new Error(`会话名称不能超过 ${maxLength} 个字符`);
  return normalized;
}
