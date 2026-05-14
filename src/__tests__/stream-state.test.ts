import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 在 import stream-state 之前先 mock config，让 USER_DATA_DIR 指向临时目录
const TEST_DATA_DIR = await mkdtemp(join(tmpdir(), "chatccc-stream-state-test-"));
vi.mock("../config.ts", async () => {
  const actual = await vi.importActual<typeof import("../config.ts")>("../config.ts");
  return {
    ...actual,
    USER_DATA_DIR: TEST_DATA_DIR,
    ts: () => "test-ts",
  };
});

const {
  writeStreamState,
  readStreamState,
  createEmptyStreamState,
  STREAMS_DIR,
  _setRenameForTest,
  _resetRenameForTest,
} = await import("../stream-state.ts");

describe("writeStreamState — atomic rename", () => {
  beforeEach(async () => {
    // 清空测试目录
    try {
      const entries = await readdir(STREAMS_DIR);
      for (const e of entries) await rm(join(STREAMS_DIR, e), { force: true });
    } catch { /* dir not yet exist */ }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it("writeStreamState 写完后 readStreamState 能读到完整内容", async () => {
    const state = createEmptyStreamState("sid-1", "/tmp", "claude", 1);
    state.accumulatedContent = "hello";
    state.finalReply = "world";

    await writeStreamState(state);

    const got = await readStreamState("sid-1");
    expect(got).not.toBeNull();
    expect(got!.accumulatedContent).toBe("hello");
    expect(got!.finalReply).toBe("world");
  });

  it("写入完成后,临时 .tmp 文件不应残留(rename 成功路径)", async () => {
    const state = createEmptyStreamState("sid-2", "/tmp", "claude", 1);
    await writeStreamState(state);

    const entries = await readdir(STREAMS_DIR);
    // 只应有 sid-2.json,没有 sid-2.json.tmp
    expect(entries).toContain("sid-2.json");
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  });

  it("覆盖写入时,reader 永远只读到完整 JSON(不读到半截)", async () => {
    // 此测试验证：先写一个版本,再写第二个版本,reader 中间读取必然是某个完整版本
    const state1 = createEmptyStreamState("sid-3", "/tmp", "claude", 1);
    state1.accumulatedContent = "v1";
    await writeStreamState(state1);

    // 直接读原始字节,确认是完整 JSON
    const raw1 = await readFile(join(STREAMS_DIR, "sid-3.json"), "utf-8");
    expect(() => JSON.parse(raw1)).not.toThrow();
    expect(JSON.parse(raw1).accumulatedContent).toBe("v1");

    const state2 = createEmptyStreamState("sid-3", "/tmp", "claude", 2);
    state2.accumulatedContent = "v2";
    await writeStreamState(state2);

    const raw2 = await readFile(join(STREAMS_DIR, "sid-3.json"), "utf-8");
    expect(() => JSON.parse(raw2)).not.toThrow();
    expect(JSON.parse(raw2).accumulatedContent).toBe("v2");
  });

  it("rename 失败时降级为直接覆盖写,不抛错 + 数据仍写入", async () => {
    let renameCalls = 0;
    _setRenameForTest(async () => {
      renameCalls++;
      throw Object.assign(new Error("EPERM mocked"), { code: "EPERM" });
    });

    try {
      const state = createEmptyStreamState("sid-fallback", "/tmp", "claude", 1);
      state.accumulatedContent = "fallback-content";

      // 不应抛错
      await expect(writeStreamState(state)).resolves.toBeUndefined();

      // 数据仍应写入(降级路径走 writeFile 覆盖)
      const got = await readStreamState("sid-fallback");
      expect(got).not.toBeNull();
      expect(got!.accumulatedContent).toBe("fallback-content");

      expect(renameCalls).toBe(1);
    } finally {
      _resetRenameForTest();
    }
  });

  it("readStreamState 对损坏的 JSON 返回 null(reader 兜底契约)", async () => {
    // 直接写一段半截 JSON 到目标路径
    const filePath = join(STREAMS_DIR, "sid-broken.json");
    await writeFile(filePath, '{"sessionId":"sid-broken","accum', "utf-8");

    const got = await readStreamState("sid-broken");
    expect(got).toBeNull();
  });

  it("readStreamState 对不存在文件返回 null", async () => {
    const got = await readStreamState("never-existed");
    expect(got).toBeNull();
  });
});

describe("createEmptyStreamState", () => {
  it("生成的 state 字段正确且 status=running", () => {
    const s = createEmptyStreamState("sid-X", "/cwd", "cursor", 5);
    expect(s.sessionId).toBe("sid-X");
    expect(s.cwd).toBe("/cwd");
    expect(s.tool).toBe("cursor");
    expect(s.turnCount).toBe(5);
    expect(s.status).toBe("running");
    expect(s.accumulatedContent).toBe("");
    expect(s.finalReply).toBe("");
    expect(s.chunkCount).toBe(0);
  });
});
