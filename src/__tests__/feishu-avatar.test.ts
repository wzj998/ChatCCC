import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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
  }));
  return import("../feishu-api.ts");
}

async function writeCodexAuth(homeDir: string): Promise<void> {
  const codexDir = join(homeDir, ".codex");
  await mkdir(codexDir, { recursive: true });
  await writeFile(
    join(codexDir, "auth.json"),
    JSON.stringify({ tokens: { access_token: "codex-access-token" } }),
    "utf-8",
  );
}

function mockAvatarFetch(uploadedNames: string[], usageResponse: Response): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlText = String(url);
    if (urlText === "https://chatgpt.com/backend-api/wham/usage") {
      return usageResponse.clone();
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
    vi.restoreAllMocks();
  });

  it("adds the 5h remaining percent to Codex avatar uploads when usage lookup succeeds", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "chatccc-avatar-home-"));
    const userDataDir = await mkdtemp(join(tmpdir(), "chatccc-avatar-data-"));
    const uploadedNames: string[] = [];
    await writeCodexAuth(homeDir);
    mockAvatarFetch(uploadedNames, new Response(JSON.stringify({
      rate_limit: { primary_window: { used_percent: 37 } },
    }), { status: 200 }));

    try {
      const { setChatAvatar } = await loadFeishuApiWithHome(homeDir, userDataDir);
      await setChatAvatar("tenant-token", "chat_1", "codex", "busy");

      expect(uploadedNames).toEqual(["avatar_codex_busy_usage_63.jpg"]);
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
