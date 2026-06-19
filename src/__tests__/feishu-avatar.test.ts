import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const mockConfig = {
  cursor: {
    avatarBatteryMode: "apiPercent",
    onDemandMonthlyBudget: 1000,
  },
};
const getCursorUsageSummaryMock = vi.fn();

async function loadFeishuApiWithHome(homeDir: string, userDataDir: string) {
  vi.resetModules();
  vi.doMock("node:os", () => ({ homedir: () => homeDir }));
  vi.doMock("../config.ts", () => ({
    APP_ID: "app_id",
    APP_SECRET: "app_secret",
    BASE_URL: "https://open.feishu.test",
    CHAT_LOGS_DIR: join(userDataDir, "logs"),
    PROJECT_ROOT: process.cwd(),
    USER_DATA_DIR: userDataDir,
    CLAUDE_SESSION_PREFIX: "Claude Code Session:",
    CURSOR_SESSION_PREFIX: "Cursor Session:",
    CODEX_SESSION_PREFIX: "Codex Session:",
    ts: () => "test-ts",
    resolveDefaultAgentTool: () => "claude",
    toolDisplayName: (tool: string) => tool,
    config: mockConfig,
  }));
  vi.doMock("../cursor-usage.ts", () => ({
    getCursorUsageSummary: getCursorUsageSummaryMock,
  }));
  return import("../feishu-api.ts");
}

async function writeCodexAuth(homeDir: string): Promise<void> {
  const codexDir = join(homeDir, ".codex");
  await mkdir(codexDir, { recursive: true });
  await writeFile(
    join(codexDir, "auth.json"),
    JSON.stringify({ tokens: { access_token: "codex-access-token", account_id: "codex-account-id" } }),
    "utf-8",
  );
}

function mockAvatarFetch(uploadedNames: string[], usageResponse: Response): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlText = String(url);
    if (urlText === "https://chatgpt.com/backend-api/wham/usage") {
      return usageResponse.clone();
    }
    if (urlText === "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits") {
      return new Response(JSON.stringify({ credits: [] }), { status: 200 });
    }
    if (urlText === "https://open.feishu.test/im/v1/images") {
      const form = init?.body as FormData;
      const image = form.get("image") as File;
      uploadedNames.push(image.name);
      return new Response(JSON.stringify({ code: 0, data: { image_key: "img_test" } }), { status: 200 });
    }
    if (urlText === "https://open.feishu.test/im/v1/chats/chat_1") {
      return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${urlText}`);
  }));
}

describe("Codex avatar usage battery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("node:os");
    vi.doUnmock("../config.ts");
    vi.doUnmock("../cursor-usage.ts");
    vi.restoreAllMocks();
    getCursorUsageSummaryMock.mockReset();
    mockConfig.cursor.avatarBatteryMode = "apiPercent";
    mockConfig.cursor.onDemandMonthlyBudget = 1000;
  });

  it("adds weekly battery and 5h ring percentages to Codex avatar uploads when usage lookup succeeds", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "chatccc-avatar-home-"));
    const userDataDir = await mkdtemp(join(tmpdir(), "chatccc-avatar-data-"));
    const uploadedNames: string[] = [];
    await writeCodexAuth(homeDir);
    mockAvatarFetch(uploadedNames, new Response(JSON.stringify({
      rate_limit: {
        primary_window: { used_percent: 37 },
        secondary_window: { used_percent: 12 },
      },
    }), { status: 200 }));

    try {
      const { setChatAvatar } = await loadFeishuApiWithHome(homeDir, userDataDir);
      await setChatAvatar("tenant-token", "chat_1", "codex", "busy");

      expect(uploadedNames).toEqual(["avatar_codex_busy_week_88_5h_63.jpg"]);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  it("returns both usage windows and available reset credit expiries", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "chatccc-avatar-home-"));
    const userDataDir = await mkdtemp(join(tmpdir(), "chatccc-avatar-data-"));
    await writeCodexAuth(homeDir);
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const urlText = String(url);
      if (urlText === "https://chatgpt.com/backend-api/wham/usage") {
        return new Response(JSON.stringify({
          rate_limit: {
            primary_window: { used_percent: 37, reset_after_seconds: 10349, reset_at: 1781528212 },
            secondary_window: { used_percent: 12, reset_after_seconds: 325063, reset_at: 1781842926 },
          },
          rate_limit_reset_credits: { available_count: 1 },
        }), { status: 200 });
      }
      if (urlText === "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits") {
        return new Response(JSON.stringify({
          available_count: 2,
          credits: [
            {
              status: "available",
              granted_at: "2026-06-12T04:01:47.770016Z",
              expires_at: "2026-07-12T04:01:47.770016Z",
            },
            {
              status: "redeemed",
              granted_at: "2026-06-13T04:01:47.770016Z",
              expires_at: "2026-07-13T04:01:47.770016Z",
            },
            {
              status: "available",
              granted_at: "2026-06-18T00:44:23.904386Z",
              expires_at: "2026-07-18T00:44:23.904386Z",
            },
          ],
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${urlText}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { getCodexUsageSummary } = await loadFeishuApiWithHome(homeDir, userDataDir);
      await expect(getCodexUsageSummary()).resolves.toEqual({
        fiveHour: { usedPercent: 37, remainingPercent: 63, resetAfterSeconds: 10349, resetAtEpochSeconds: 1781528212 },
        weekly: { usedPercent: 12, remainingPercent: 88, resetAfterSeconds: 325063, resetAtEpochSeconds: 1781842926 },
        rateLimitResetCreditsAvailable: 2,
        rateLimitResetCredits: [
          { grantedAt: "2026-06-12T04:01:47.770016Z", expiresAt: "2026-07-12T04:01:47.770016Z" },
          { grantedAt: "2026-06-18T00:44:23.904386Z", expiresAt: "2026-07-18T00:44:23.904386Z" },
        ],
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer codex-access-token",
            "ChatGPT-Account-ID": "codex-account-id",
            "OpenAI-Beta": "codex-1",
            originator: "Codex Desktop",
          }),
        }),
      );
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  it("consumes a Codex rate-limit reset credit through the WHAM endpoint", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "chatccc-avatar-home-"));
    const userDataDir = await mkdtemp(join(tmpdir(), "chatccc-avatar-data-"));
    await writeCodexAuth(homeDir);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      code: "reset",
      windows_reset: 2,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { consumeCodexRateLimitResetCredit } = await loadFeishuApiWithHome(homeDir, userDataDir);
      await expect(consumeCodexRateLimitResetCredit("request-1")).resolves.toEqual({
        code: "reset",
        windowsReset: 2,
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer codex-access-token",
            "Content-Type": "application/json",
          }),
          body: JSON.stringify({ redeem_request_id: "request-1" }),
        }),
      );
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  it("falls back to the pre-combined Codex avatar when usage lookup fails", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "chatccc-avatar-home-"));
    const userDataDir = await mkdtemp(join(tmpdir(), "chatccc-avatar-data-"));
    const uploadedNames: string[] = [];
    await writeCodexAuth(homeDir);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockAvatarFetch(uploadedNames, new Response("fail", { status: 500 }));

    try {
      const { setChatAvatar } = await loadFeishuApiWithHome(homeDir, userDataDir);
      await setChatAvatar("tenant-token", "chat_1", "codex", "idle");

      expect(uploadedNames).toEqual(["avatar_codex_idle.jpg"]);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(userDataDir, { recursive: true, force: true });
    }
  });
});

describe("Cursor avatar usage battery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("node:os");
    vi.doUnmock("../config.ts");
    vi.doUnmock("../cursor-usage.ts");
    vi.restoreAllMocks();
    getCursorUsageSummaryMock.mockReset();
    mockConfig.cursor.avatarBatteryMode = "apiPercent";
    mockConfig.cursor.onDemandMonthlyBudget = 1000;
  });

  it("uses remaining API percentage for Cursor avatar battery", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "chatccc-avatar-home-"));
    const userDataDir = await mkdtemp(join(tmpdir(), "chatccc-avatar-data-"));
    const uploadedNames: string[] = [];
    getCursorUsageSummaryMock.mockResolvedValue({
      planUsage: { apiPercentUsed: 40 },
    });
    mockAvatarFetch(uploadedNames, new Response("unused", { status: 500 }));

    try {
      const { setChatAvatar } = await loadFeishuApiWithHome(homeDir, userDataDir);
      await setChatAvatar("tenant-token", "chat_1", "cursor", "busy");

      expect(uploadedNames).toEqual(["avatar_cursor_busy_battery_60.jpg"]);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  it("uses On-Demand budget for Cursor avatar battery when configured", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "chatccc-avatar-home-"));
    const userDataDir = await mkdtemp(join(tmpdir(), "chatccc-avatar-data-"));
    const uploadedNames: string[] = [];
    mockConfig.cursor.avatarBatteryMode = "onDemandUse";
    mockConfig.cursor.onDemandMonthlyBudget = 1000;
    getCursorUsageSummaryMock.mockResolvedValue({
      spendLimitUsage: { individualUsed: 25000 },
    });
    mockAvatarFetch(uploadedNames, new Response("unused", { status: 500 }));

    try {
      const { setChatAvatar } = await loadFeishuApiWithHome(homeDir, userDataDir);
      await setChatAvatar("tenant-token", "chat_1", "cursor", "idle");

      expect(uploadedNames).toEqual(["avatar_cursor_idle_battery_75.jpg"]);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  it("falls back to the pre-combined Cursor avatar when usage lookup fails", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "chatccc-avatar-home-"));
    const userDataDir = await mkdtemp(join(tmpdir(), "chatccc-avatar-data-"));
    const uploadedNames: string[] = [];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    getCursorUsageSummaryMock.mockRejectedValue(new Error("cursor unavailable"));
    mockAvatarFetch(uploadedNames, new Response("unused", { status: 500 }));

    try {
      const { setChatAvatar } = await loadFeishuApiWithHome(homeDir, userDataDir);
      await setChatAvatar("tenant-token", "chat_1", "cursor", "busy");

      expect(uploadedNames).toEqual(["avatar_cursor_busy.jpg"]);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(userDataDir, { recursive: true, force: true });
    }
  });
});
