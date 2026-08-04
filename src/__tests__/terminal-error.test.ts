import { describe, expect, it } from "vitest";

import { classifyTerminalError, formatTerminalErrorNotice } from "../terminal-error.ts";

describe("terminal error classification", () => {
  it("turns a retried connection timeout into an actionable root-cause summary", () => {
    const error = classifyTerminalError(new Error(
      "Failed after 3 attempts. Last error: Cannot connect to API: Connect Timeout Error " +
      "(attempted addresses: 172.19.67.251:443, 172.19.68.1:443, timeout: 10000ms)",
    ), 123);

    expect(error).toEqual({
      kind: "network_timeout",
      title: "网络连接超时",
      message: "连接模型服务失败，已重试 3 次，单次连接等待 10 秒。请检查网络、VPN或模型服务状态后重试。",
      occurredAt: 123,
    });
    expect(JSON.stringify(error)).not.toContain("172.19.67.251");
  });

  it("redacts credentials from an otherwise unknown error", () => {
    const error = classifyTerminalError(
      new Error("custom provider rejected api_key=secret-value Bearer eyJ.private sk-live-secret"),
      456,
    );

    expect(error.kind).toBe("unknown");
    expect(error.message).toContain("custom provider rejected");
    expect(error.message).not.toContain("secret-value");
    expect(error.message).not.toContain("eyJ.private");
    expect(error.message).not.toContain("sk-live-secret");
  });

  it("marks an existing reply as potentially incomplete", () => {
    const error = classifyTerminalError(new Error("HTTP 429 rate limit"), 789);
    const notice = formatTerminalErrorNotice(error, "partial answer");

    expect(notice).toContain("请求受到限流");
    expect(notice).toContain("以下回复可能不完整");
    expect(notice).toContain("partial answer");
  });

  it.each([
    ["HTTP 401 unauthorized", "authentication", "模型服务鉴权失败"],
    ["HTTP 429 too many requests", "rate_limit", "请求受到限流"],
    ["HTTP 503 service unavailable", "provider", "模型服务暂时不可用"],
    ["getaddrinfo ENOTFOUND api.example.test", "network", "无法连接模型服务"],
  ] as const)("classifies %s as %s", (message, kind, title) => {
    const error = classifyTerminalError(new Error(message), 999);

    expect(error.kind).toBe(kind);
    expect(error.title).toBe(title);
  });
});
