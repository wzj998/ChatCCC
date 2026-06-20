export function cwdDisplayName(cwd: string): string {
  const trimmed = cwd.trim().replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).filter(Boolean).pop() || trimmed || "cwd";
}

export function sessionChatName(left: string, cwd: string): string {
  return `${left}-${cwdDisplayName(cwd)}`;
}
