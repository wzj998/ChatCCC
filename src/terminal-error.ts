/** 用户可见的终态错误。这里只保存脱敏摘要；完整原始异常继续只写运行日志。 */
export type TerminalErrorKind =
  | "network_timeout"
  | "network"
  | "authentication"
  | "rate_limit"
  | "provider"
  | "process"
  | "resource"
  | "unknown";

export interface TerminalErrorInfo {
  kind: TerminalErrorKind;
  title: string;
  message: string;
  occurredAt: number;
}

const MAX_UNKNOWN_ERROR_LENGTH = 300;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * 未分类错误仍应给出可诊断线索，但不能把常见凭据带进群聊或持久化状态。
 * 已分类错误使用固定文案，不复述地址、请求体或 provider 原始响应。
 */
export function sanitizeTerminalErrorDetail(raw: string): string {
  return raw
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [已脱敏]")
    .replace(/\b(api[_-]?key|access[_-]?token|token|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[已脱敏]")
    .replace(/\bsk-[A-Za-z0-9._-]{6,}\b/g, "sk-[已脱敏]")
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|secret)=)[^&\s]+/gi, "$1[已脱敏]")
    .slice(0, MAX_UNKNOWN_ERROR_LENGTH);
}

function parsePositiveInt(message: string, pattern: RegExp): number | undefined {
  const value = Number.parseInt(message.match(pattern)?.[1] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function formatSeconds(milliseconds: number): string {
  if (milliseconds % 1000 === 0) return `${milliseconds / 1000} 秒`;
  return `${milliseconds} 毫秒`;
}

export function classifyTerminalError(error: unknown, occurredAt = Date.now()): TerminalErrorInfo {
  const raw = errorMessage(error);
  const lower = raw.toLowerCase();
  const attempts = parsePositiveInt(raw, /\bafter\s+(\d+)\s+attempts?\b/i);
  const timeoutMs = parsePositiveInt(raw, /\btimeout\s*:\s*(\d+)\s*ms\b/i);

  if (/\b429\b|rate[ _-]?limit|too many requests/.test(lower)) {
    return {
      kind: "rate_limit",
      title: "请求受到限流",
      message: "模型服务请求受到限流，请稍后重试。",
      occurredAt,
    };
  }

  if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid api key|authentication/.test(lower)) {
    return {
      kind: "authentication",
      title: "模型服务鉴权失败",
      message: "模型服务拒绝了当前凭据，请检查 API Key、账号权限或凭据是否过期。",
      occurredAt,
    };
  }

  if (
    /connect timeout|connection timed out|etimedout|und_err_connect_timeout/.test(lower)
    || (lower.includes("cannot connect") && lower.includes("timeout"))
  ) {
    const retryText = attempts ? `，已重试 ${attempts} 次` : "";
    const timeoutText = timeoutMs ? `，单次连接等待 ${formatSeconds(timeoutMs)}` : "";
    return {
      kind: "network_timeout",
      title: "网络连接超时",
      message: `连接模型服务失败${retryText}${timeoutText}。请检查网络、VPN或模型服务状态后重试。`,
      occurredAt,
    };
  }

  if (/econnrefused|econnreset|enotfound|eai_again|socket hang up|network error|cannot connect/.test(lower)) {
    return {
      kind: "network",
      title: "无法连接模型服务",
      message: "与模型服务的网络连接失败，请检查网络、VPN、DNS或服务状态后重试。",
      occurredAt,
    };
  }

  const httpStatus = raw.match(/\b(?:HTTP\s*)?(5\d\d)\b/i)?.[1];
  if (httpStatus || /service unavailable|bad gateway|gateway timeout|provider error/.test(lower)) {
    return {
      kind: "provider",
      title: "模型服务暂时不可用",
      message: `模型服务返回异常${httpStatus ? `（HTTP ${httpStatus}）` : ""}，请稍后重试。`,
      occurredAt,
    };
  }

  const safeDetail = sanitizeTerminalErrorDetail(raw).trim() || "未提供错误详情";
  return {
    kind: "unknown",
    title: "Agent 执行错误",
    message: `发生未分类错误：${safeDetail}`,
    occurredAt,
  };
}

export function formatTerminalErrorReason(error: TerminalErrorInfo): string {
  return `⚠️ 异常结束：${error.title}\n${error.message}`;
}

export function formatTerminalErrorNotice(error: TerminalErrorInfo, finalReply = ""): string {
  const reason = formatTerminalErrorReason(error);
  return finalReply.trim()
    ? `${reason}\n\n以下回复可能不完整：\n\n${finalReply.trim()}`
    : reason;
}
