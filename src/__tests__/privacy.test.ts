import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
let getPrivacyConfig: () => { enabled: boolean; rules: Record<string, string> };

beforeEach(async () => {
  vi.resetModules();
  try {
    await rm(join(TEST_DATA_DIR, "privacy.json"), { force: true });
  } catch {}
  const mod = await import("../privacy.ts");
  applyPrivacy = mod.applyPrivacy;
  reloadPrivacyRules = mod.reloadPrivacyRules;
  getPrivacyRules = mod.getPrivacyRules;
  getPrivacyConfig = mod.getPrivacyConfig;
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
  it("returns original text when privacy.json is missing", () => {
    reloadPrivacyRules();
    expect(applyPrivacy("hello weizhangjian")).toBe("hello weizhangjian");
  });

  it("supports legacy flat privacy rules", async () => {
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

  it("supports privacy.json schema with enabled=false", async () => {
    await writeFile(
      join(TEST_DATA_DIR, "privacy.json"),
      JSON.stringify({ enabled: false, rules: { weizhangjian: "wzj" } }),
      "utf-8",
    );
    reloadPrivacyRules();

    expect(getPrivacyConfig()).toEqual({ enabled: false, rules: { weizhangjian: "wzj" } });
    expect(getPrivacyRules()).toEqual({ weizhangjian: "wzj" });
    expect(applyPrivacy("hello weizhangjian")).toBe("hello weizhangjian");
  });

  it("supports privacy.json schema with enabled=true", async () => {
    await writeFile(
      join(TEST_DATA_DIR, "privacy.json"),
      JSON.stringify({ enabled: true, rules: { weizhangjian: "wzj" } }),
      "utf-8",
    );
    reloadPrivacyRules();

    expect(applyPrivacy("hello weizhangjian")).toBe("hello wzj");
  });

  it("accepts UTF-8 BOM in privacy.json", async () => {
    await writeFile(
      join(TEST_DATA_DIR, "privacy.json"),
      `\uFEFF${JSON.stringify({ enabled: false, rules: { weizhangjian: "wzj" } })}`,
      "utf-8",
    );
    reloadPrivacyRules();

    expect(getPrivacyConfig()).toEqual({ enabled: false, rules: { weizhangjian: "wzj" } });
    expect(applyPrivacy("hello weizhangjian")).toBe("hello weizhangjian");
  });

  it("auto reloads privacy.json changes without explicit reload", async () => {
    await writeFile(
      join(TEST_DATA_DIR, "privacy.json"),
      JSON.stringify({ weizhangjian: "wzj" }),
      "utf-8",
    );
    reloadPrivacyRules();

    expect(applyPrivacy("hello weizhangjian")).toBe("hello wzj");

    await writeFile(
      join(TEST_DATA_DIR, "privacy.json"),
      JSON.stringify({ enabled: false, rules: { weizhangjian: "wzj-disabled" } }),
      "utf-8",
    );

    expect(applyPrivacy("hello weizhangjian")).toBe("hello weizhangjian");
    expect(getPrivacyConfig()).toEqual({ enabled: false, rules: { weizhangjian: "wzj-disabled" } });
  });

  it("replaces multiple rules and repeated occurrences", async () => {
    await writeFile(
      join(TEST_DATA_DIR, "privacy.json"),
      JSON.stringify({ a: "A", b: "B" }),
      "utf-8",
    );
    reloadPrivacyRules();

    expect(applyPrivacy("a b a b")).toBe("A B A B");
  });

  it("returns empty text directly", async () => {
    await writeFile(
      join(TEST_DATA_DIR, "privacy.json"),
      JSON.stringify({ x: "y" }),
      "utf-8",
    );
    reloadPrivacyRules();

    expect(applyPrivacy("")).toBe("");
  });

  it("treats special characters in rule keys literally", async () => {
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

  it("reloadPrivacyRules forces a reload", async () => {
    await writeFile(
      join(TEST_DATA_DIR, "privacy.json"),
      JSON.stringify({ old: "OLD" }),
      "utf-8",
    );
    reloadPrivacyRules();

    expect(applyPrivacy("old")).toBe("OLD");
    expect(getPrivacyRules()).toEqual({ old: "OLD" });

    await writeFile(
      join(TEST_DATA_DIR, "privacy.json"),
      JSON.stringify({ new: "NEW" }),
      "utf-8",
    );
    reloadPrivacyRules();

    expect(applyPrivacy("new")).toBe("NEW");
    expect(getPrivacyRules()).toEqual({ new: "NEW" });
  });

  it("returns original text for malformed JSON", async () => {
    await writeFile(
      join(TEST_DATA_DIR, "privacy.json"),
      "not json",
      "utf-8",
    );
    reloadPrivacyRules();

    expect(applyPrivacy("hello")).toBe("hello");
  });

  it("returns original text for array JSON", async () => {
    await writeFile(
      join(TEST_DATA_DIR, "privacy.json"),
      JSON.stringify(["a", "b"]),
      "utf-8",
    );
    reloadPrivacyRules();

    expect(applyPrivacy("hello")).toBe("hello");
  });
});
