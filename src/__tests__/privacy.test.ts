import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 在 import privacy 之前 mock config，让 USER_DATA_DIR 指向临时目录
const TEST_DATA_DIR = await mkdtemp(join(tmpdir(), "chatccc-privacy-test-"));
vi.mock("../config.ts", async () => {
  const actual = await vi.importActual<typeof import("../config.ts")>("../config.ts");
  return {
    ...actual,
    USER_DATA_DIR: TEST_DATA_DIR,
    ts: () => "test-ts",
  };
});

let applyPrivacy: (text: string) => string;
let reloadPrivacyRules: () => void;
let getPrivacyRules: () => Record<string, string>;

beforeEach(async () => {
  vi.resetModules();
  // 清理临时目录中的 privacy.json
  try {
    await rm(join(TEST_DATA_DIR, "privacy.json"), { force: true });
  } catch {}
  const mod = await import("../privacy.ts");
  applyPrivacy = mod.applyPrivacy;
  reloadPrivacyRules = mod.reloadPrivacyRules;
  getPrivacyRules = mod.getPrivacyRules;
});

afterEach(async () => {
  try {
    await rm(join(TEST_DATA_DIR, "privacy.json"), { force: true });
  } catch {}
});

afterAll(async () => {
  try {
    await rm(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {}
});

describe("applyPrivacy", () => {
  it("无 privacy.json 时返回原文", () => {
    reloadPrivacyRules();
    expect(applyPrivacy("hello weizhangjian")).toBe("hello weizhangjian");
  });

  it("privacy.json 存在时按规则替换", async () => {
    await writeFile(
      join(TEST_DATA_DIR, "privacy.json"),
      JSON.stringify({ weizhangjian: "wzj", secret: "***" }),
      "utf-8",
    );
    reloadPrivacyRules();

    expect(applyPrivacy("hello weizhangjian")).toBe("hello wzj");
    expect(applyPrivacy("my secret is safe")).toBe("my *** is safe");
    expect(applyPrivacy("weizhangjian and secret")).toBe("wzj and ***");
  });

  it("多规则替换多次出现", async () => {
    await writeFile(
      join(TEST_DATA_DIR, "privacy.json"),
      JSON.stringify({ a: "A", b: "B" }),
      "utf-8",
    );
    reloadPrivacyRules();

    expect(applyPrivacy("a b a b")).toBe("A B A B");
  });

  it("空文本直接返回", async () => {
    await writeFile(
      join(TEST_DATA_DIR, "privacy.json"),
      JSON.stringify({ x: "y" }),
      "utf-8",
    );
    reloadPrivacyRules();

    expect(applyPrivacy("")).toBe("");
  });

  it("规则中的特殊字符不会被当作正则", async () => {
    await writeFile(
      join(TEST_DATA_DIR, "privacy.json"),
      JSON.stringify({ "a.b": "X", "(test)": "Y", "*star": "Z" }),
      "utf-8",
    );
    reloadPrivacyRules();

    expect(applyPrivacy("hello a.b world")).toBe("hello X world");
    expect(applyPrivacy("text (test) here")).toBe("text Y here");
    expect(applyPrivacy("a *star shines")).toBe("a Z shines");
  });

  it("reloadPrivacyRules 强制重新加载", async () => {
    await writeFile(
      join(TEST_DATA_DIR, "privacy.json"),
      JSON.stringify({ old: "OLD" }),
      "utf-8",
    );
    reloadPrivacyRules();

    expect(applyPrivacy("old")).toBe("OLD");
    expect(getPrivacyRules()).toEqual({ old: "OLD" });

    // 变更磁盘内容后 reload
    await writeFile(
      join(TEST_DATA_DIR, "privacy.json"),
      JSON.stringify({ new: "NEW" }),
      "utf-8",
    );
    reloadPrivacyRules();

    expect(applyPrivacy("new")).toBe("NEW");
    expect(getPrivacyRules()).toEqual({ new: "NEW" });
  });

  it("格式错误的 JSON 不抛异常，返回原文", async () => {
    await writeFile(
      join(TEST_DATA_DIR, "privacy.json"),
      "not json",
      "utf-8",
    );
    reloadPrivacyRules();

    expect(applyPrivacy("hello")).toBe("hello");
  });

  it("数组格式的 JSON 不抛异常，返回原文", async () => {
    await writeFile(
      join(TEST_DATA_DIR, "privacy.json"),
      JSON.stringify(["a", "b"]),
      "utf-8",
    );
    reloadPrivacyRules();

    expect(applyPrivacy("hello")).toBe("hello");
  });
});