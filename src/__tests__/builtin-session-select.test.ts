import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { defaultBuiltinSessionId } from "../builtin/context.ts";
import { resolveBuiltinSession } from "../builtin/session-select.ts";

async function writeSession(
  contextDir: string,
  sessionId: string,
  options: { cwd?: string; updatedAt: number; totalMessages?: number },
): Promise<void> {
  const dir = join(contextDir, sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "context.json"),
    JSON.stringify({
      version: 1,
      createdAt: options.updatedAt,
      updatedAt: options.updatedAt,
      sessionId,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      summary: "",
      messages: [],
      totalMessages: options.totalMessages ?? 0,
      compactedMessages: 0,
    }),
    "utf8",
  );
}

describe("resolveBuiltinSession", () => {
  it("creates a fresh timestamp session by default", async () => {
    const contextDir = await mkdtemp(join(tmpdir(), "chatccc-session-select-new-"));

    const result = resolveBuiltinSession({
      cwd: "C:\\repo",
      contextDir,
      now: new Date(2026, 6, 2, 12, 15, 30),
      randomSuffix: "a1b2c3",
    });

    expect(result).toEqual({
      mode: "new",
      sessionId: "session-20260702-121530-a1b2c3",
    });
  });

  it("resumes an explicit existing session id", async () => {
    const contextDir = join(tmpdir(), `chatccc-session-select-explicit-${Date.now()}`);
    await writeSession(contextDir, "manual-session", { updatedAt: 1 });

    expect(resolveBuiltinSession({
      cwd: "C:\\repo",
      contextDir,
      resume: "manual-session",
    })).toEqual({
      mode: "resumed",
      sessionId: "manual-session",
    });
  });

  it("fails when an explicit session id does not exist", async () => {
    const contextDir = join(tmpdir(), `chatccc-session-select-missing-${Date.now()}`);

    expect(() => resolveBuiltinSession({
      cwd: "C:\\repo",
      contextDir,
      resume: "missing",
    })).toThrow("未找到 ccc 会话: missing");
  });

  it("resumes the newest session for cwd when resume has no id", async () => {
    const contextDir = join(tmpdir(), `chatccc-session-select-cwd-${Date.now()}`);
    await writeSession(contextDir, "old-match", { cwd: "C:\\repo", updatedAt: 1_000 });
    await writeSession(contextDir, "new-match", { cwd: "C:\\repo", updatedAt: 2_000 });
    await writeSession(contextDir, "other-cwd", { cwd: "C:\\other", updatedAt: 3_000 });

    expect(resolveBuiltinSession({
      cwd: "C:\\repo",
      contextDir,
      resume: true,
    })).toEqual({
      mode: "resumed",
      sessionId: "new-match",
    });
  });

  it("resumes legacy cwd-hash sessions when resume has no id", async () => {
    const contextDir = join(tmpdir(), `chatccc-session-select-legacy-${Date.now()}`);
    const cwd = "C:\\repo";
    const legacySessionId = defaultBuiltinSessionId(cwd);
    await writeSession(contextDir, legacySessionId, { updatedAt: 1_000 });

    expect(resolveBuiltinSession({
      cwd,
      contextDir,
      resume: true,
    })).toEqual({
      mode: "resumed",
      sessionId: legacySessionId,
    });
  });

  it("fails when there is no cwd session to resume", async () => {
    const contextDir = join(tmpdir(), `chatccc-session-select-empty-${Date.now()}`);

    expect(() => resolveBuiltinSession({
      cwd: "C:\\repo",
      contextDir,
      resume: true,
    })).toThrow("未找到当前目录可恢复的 ccc 会话");
  });
});
