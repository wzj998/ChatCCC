// =============================================================================
// cursor-session-meta-store.test.ts — sessionId→{cwd,model} 持久化的护栏单测
// =============================================================================
// 行为契约（与 cursor-adapter.getSessionInfo 配合，决定 /git、/state、/sessions
// 在 Cursor 会话上是否显示正确）：
//   - 文件不存在 / 损坏 / 非法 schema 时 get 返回 undefined，不抛异常
//   - set 部分合并：只覆盖非空字段，已有字段保持不变
//   - 同实例 set→get 立即可读（内存缓存）
//   - 跨实例（同 filePath）get 仍能读到（落盘验证）
//   - cwd 缺失的记录视为不完整（get 返回 undefined）
//   - 历史 schema（值为字符串）兼容读取，被视作 { cwd: <string> }
//   - 多 sessionId 互不影响
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCursorSessionMetaStore } from "../adapters/cursor-session-meta-store.ts";

let tmpDir: string;
let storePath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "chatccc-metastore-"));
  storePath = join(tmpDir, "cursor-session-meta.json");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("createCursorSessionMetaStore — 文件不存在 / 损坏的鲁棒性", () => {
  it("文件不存在时 get 返回 undefined（不抛）", async () => {
    const store = createCursorSessionMetaStore(storePath);
    await expect(store.get("any-sid")).resolves.toBeUndefined();
  });

  it("JSON 损坏时 get 返回 undefined，且后续 set 仍可正常写入", async () => {
    await writeFile(storePath, "{not valid json", "utf-8");
    const store = createCursorSessionMetaStore(storePath);

    await expect(store.get("sid-1")).resolves.toBeUndefined();
    await store.set("sid-1", { cwd: "/tmp/recovered" });
    await expect(store.get("sid-1")).resolves.toEqual({ cwd: "/tmp/recovered" });
  });

  it("文件根是数组而非对象时视作空映射（防御非法 schema）", async () => {
    await writeFile(storePath, JSON.stringify(["sid-1", "/tmp"]), "utf-8");
    const store = createCursorSessionMetaStore(storePath);
    await expect(store.get("sid-1")).resolves.toBeUndefined();
  });

  it("条目为非对象/非字符串时被忽略（防御非法 schema）", async () => {
    await writeFile(
      storePath,
      JSON.stringify({
        "sid-ok": { cwd: "/tmp/ok" },
        "sid-num": 123,
        "sid-null": null,
        "sid-arr": ["x"],
      }),
      "utf-8",
    );
    const store = createCursorSessionMetaStore(storePath);
    await expect(store.get("sid-ok")).resolves.toEqual({ cwd: "/tmp/ok" });
    await expect(store.get("sid-num")).resolves.toBeUndefined();
    await expect(store.get("sid-null")).resolves.toBeUndefined();
    await expect(store.get("sid-arr")).resolves.toBeUndefined();
  });

  it("条目对象内 cwd 缺失或非字符串 → get 返回 undefined（视为不完整）", async () => {
    await writeFile(
      storePath,
      JSON.stringify({
        "sid-no-cwd": { model: "Composer 2 Fast" },
        "sid-cwd-num": { cwd: 123, model: "X" },
        "sid-good": { cwd: "/tmp", model: "Composer 2 Fast" },
      }),
      "utf-8",
    );
    const store = createCursorSessionMetaStore(storePath);
    await expect(store.get("sid-no-cwd")).resolves.toBeUndefined();
    await expect(store.get("sid-cwd-num")).resolves.toBeUndefined();
    await expect(store.get("sid-good")).resolves.toEqual({
      cwd: "/tmp",
      model: "Composer 2 Fast",
    });
  });
});

describe("createCursorSessionMetaStore — 历史 schema 兼容（值为字符串）", () => {
  it("v1 schema：value 为字符串视作 { cwd: <string> }", async () => {
    await writeFile(
      storePath,
      JSON.stringify({ "sid-v1": "/legacy/path" }),
      "utf-8",
    );
    const store = createCursorSessionMetaStore(storePath);
    await expect(store.get("sid-v1")).resolves.toEqual({ cwd: "/legacy/path" });
  });

  it("空字符串值不被视为合法 v1 记录", async () => {
    await writeFile(storePath, JSON.stringify({ "sid-empty": "" }), "utf-8");
    const store = createCursorSessionMetaStore(storePath);
    await expect(store.get("sid-empty")).resolves.toBeUndefined();
  });
});

describe("createCursorSessionMetaStore — 读写循环", () => {
  it("set { cwd } 后 get 返回相同 cwd（无 model 字段）", async () => {
    const store = createCursorSessionMetaStore(storePath);
    await store.set("sid-1", { cwd: "F:/proj" });
    await expect(store.get("sid-1")).resolves.toEqual({ cwd: "F:/proj" });
  });

  it("set { cwd, model } 后 get 返回完整 meta", async () => {
    const store = createCursorSessionMetaStore(storePath);
    await store.set("sid-1", { cwd: "F:/proj", model: "Composer 2 Fast" });
    await expect(store.get("sid-1")).resolves.toEqual({
      cwd: "F:/proj",
      model: "Composer 2 Fast",
    });
  });

  it("set 后跨实例（同 filePath）get 仍能读到（落盘验证）", async () => {
    const writer = createCursorSessionMetaStore(storePath);
    await writer.set("sid-1", { cwd: "/home/u/code", model: "Sonnet 4.7" });

    const reader = createCursorSessionMetaStore(storePath);
    await expect(reader.get("sid-1")).resolves.toEqual({
      cwd: "/home/u/code",
      model: "Sonnet 4.7",
    });
  });

  it("set 部分合并：只更新 cwd 不会清空已有 model", async () => {
    const store = createCursorSessionMetaStore(storePath);
    await store.set("sid-1", { cwd: "/old", model: "Composer 2 Fast" });
    await store.set("sid-1", { cwd: "/new" });
    await expect(store.get("sid-1")).resolves.toEqual({
      cwd: "/new",
      model: "Composer 2 Fast",
    });
  });

  it("set 部分合并：只更新 model 不会清空已有 cwd", async () => {
    const store = createCursorSessionMetaStore(storePath);
    await store.set("sid-1", { cwd: "/keep", model: "v1" });
    await store.set("sid-1", { model: "v2" });
    await expect(store.get("sid-1")).resolves.toEqual({
      cwd: "/keep",
      model: "v2",
    });
  });

  it("set 时 partial 中的空字符串 / undefined 字段不会覆盖已有值", async () => {
    const store = createCursorSessionMetaStore(storePath);
    await store.set("sid-1", { cwd: "/keep", model: "v1" });
    await store.set("sid-1", { cwd: "", model: undefined });
    await expect(store.get("sid-1")).resolves.toEqual({
      cwd: "/keep",
      model: "v1",
    });
  });

  it("第一次 set 不含 cwd → 记录不完整 → get 返回 undefined", async () => {
    const store = createCursorSessionMetaStore(storePath);
    await store.set("sid-1", { model: "Composer 2 Fast" });
    await expect(store.get("sid-1")).resolves.toBeUndefined();
  });

  it("多 sessionId 互不影响", async () => {
    const store = createCursorSessionMetaStore(storePath);
    await store.set("sid-A", { cwd: "/a", model: "mA" });
    await store.set("sid-B", { cwd: "/b" });
    await store.set("sid-C", { cwd: "/c", model: "mC" });

    await expect(store.get("sid-A")).resolves.toEqual({ cwd: "/a", model: "mA" });
    await expect(store.get("sid-B")).resolves.toEqual({ cwd: "/b" });
    await expect(store.get("sid-C")).resolves.toEqual({ cwd: "/c", model: "mC" });
    await expect(store.get("sid-missing")).resolves.toBeUndefined();
  });

  it("set 完全相同的 partial 不会重复写盘（性能优化，行为不变）", async () => {
    const store = createCursorSessionMetaStore(storePath);
    await store.set("sid-1", { cwd: "/same", model: "mSame" });

    // 先把文件覆盖为非法内容；如果跳过 IO 则文件保持非法内容
    await writeFile(storePath, "MARKER_NOT_JSON", "utf-8");
    await store.set("sid-1", { cwd: "/same", model: "mSame" });

    const raw = await readFile(storePath, "utf-8");
    expect(raw).toBe("MARKER_NOT_JSON");
  });

  it("父目录不存在时 set 会自动创建", async () => {
    const nestedPath = join(tmpDir, "a", "b", "c", "meta.json");
    const store = createCursorSessionMetaStore(nestedPath);
    await store.set("sid-1", { cwd: "/deep", model: "deepModel" });
    await expect(store.get("sid-1")).resolves.toEqual({
      cwd: "/deep",
      model: "deepModel",
    });

    const raw = await readFile(nestedPath, "utf-8");
    expect(JSON.parse(raw)).toEqual({
      "sid-1": { cwd: "/deep", model: "deepModel" },
    });
  });
});
