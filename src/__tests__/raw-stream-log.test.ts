import { gunzipSync } from "node:zlib";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  createRawStreamLog,
  sanitizeLogPathSegment,
} from "../adapters/raw-stream-log.ts";

describe("raw stream log", () => {
  it("does nothing when disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatccc-raw-log-"));
    try {
      const log = await createRawStreamLog({
        enabled: false,
        rootDir: root,
        tool: "cursor",
        sessionId: "sid",
        label: "turn",
        maxBytesPerTurn: 1024,
        retentionDays: 7,
      });
      expect(log).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes gzipped JSONL and can keep the file", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatccc-raw-log-"));
    try {
      const log = await createRawStreamLog({
        enabled: true,
        rootDir: root,
        tool: "cursor",
        sessionId: "sid/unsafe",
        label: "turn:1",
        maxBytesPerTurn: 1024,
        retentionDays: 7,
      });
      expect(log).not.toBeNull();
      log!.writeLine('{"type":"assistant","text":"hello"}');
      await log!.close({ keep: true });

      const raw = gunzipSync(await readFile(log!.filePath)).toString("utf-8");
      expect(raw).toBe('{"type":"assistant","text":"hello"}\n');
      expect(await stat(log!.filePath)).toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes a truncation marker once maxBytesPerTurn is exceeded", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatccc-raw-log-"));
    try {
      const log = await createRawStreamLog({
        enabled: true,
        rootDir: root,
        tool: "cursor",
        sessionId: "sid",
        label: "turn",
        maxBytesPerTurn: 12,
        retentionDays: 7,
      });
      log!.writeLine('{"a":1}');
      log!.writeLine('{"too":"large"}');
      log!.writeLine('{"ignored":true}');
      await log!.close({ keep: true });

      const raw = gunzipSync(await readFile(log!.filePath)).toString("utf-8");
      expect(raw).toContain('{"a":1}');
      expect(raw).toContain("chatccc_raw_stream_log_truncated");
      expect(raw).not.toContain("ignored");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes the file when keep is false", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatccc-raw-log-"));
    try {
      const log = await createRawStreamLog({
        enabled: true,
        rootDir: root,
        tool: "cursor",
        sessionId: "sid",
        label: "turn",
        maxBytesPerTurn: 1024,
        retentionDays: 7,
      });
      log!.writeLine('{"type":"result"}');
      await log!.close({ keep: false });
      await expect(stat(log!.filePath)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("sanitizes path segments", () => {
    expect(sanitizeLogPathSegment("../sid:1/2")).toBe("sid_1_2");
    expect(sanitizeLogPathSegment("")).toBe("unknown");
  });
});
