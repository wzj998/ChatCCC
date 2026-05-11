import { describe, it, expect, vi } from "vitest";

// 注意：这里特意 import 自 `../config-utils.ts` 而不是 `../config.ts`。
// `../config.ts` 在模块顶层会执行 loadConfig()——在生产环境下，当 config.json
// 不存在时它会从 config.sample.json 自动复制一份过去。我们额外靠 VITEST 环境
// 变量在 loadConfig() 里跳过这次写文件，但能不触发就尽量不触发。
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_GIT_TIMEOUT_SECONDS,
  MAX_GIT_TIMEOUT_SECONDS,
  MIN_GIT_TIMEOUT_SECONDS,
  autoDetectCodexPath,
  autoDetectCursorPath,
  normalizeOptionalConfigField,
  parseGitTimeoutSeconds,
  readToolCliPath,
} from "../config-utils.ts";

describe("parseGitTimeoutSeconds", () => {
  it("returns default when raw is undefined", () => {
    const r = parseGitTimeoutSeconds(undefined);
    expect(r.seconds).toBe(DEFAULT_GIT_TIMEOUT_SECONDS);
    expect(r.valid).toBe(true);
    expect(r.usingDefault).toBe(true);
    expect(r.raw).toBeUndefined();
  });

  it("returns default when raw is empty / whitespace only", () => {
    expect(parseGitTimeoutSeconds("")).toMatchObject({
      seconds: DEFAULT_GIT_TIMEOUT_SECONDS,
      valid: true,
      usingDefault: true,
    });
    expect(parseGitTimeoutSeconds("   ")).toMatchObject({
      seconds: DEFAULT_GIT_TIMEOUT_SECONDS,
      valid: true,
      usingDefault: true,
    });
  });

  it("trims and uses user value when valid integer in range", () => {
    expect(parseGitTimeoutSeconds("90")).toMatchObject({
      seconds: 90,
      valid: true,
      usingDefault: false,
      raw: "90",
    });
    expect(parseGitTimeoutSeconds("  600  ")).toMatchObject({
      seconds: 600,
      valid: true,
      usingDefault: false,
      raw: "600",
    });
  });

  it("accepts boundary values MIN and MAX", () => {
    expect(parseGitTimeoutSeconds(String(MIN_GIT_TIMEOUT_SECONDS))).toMatchObject({
      seconds: MIN_GIT_TIMEOUT_SECONDS,
      valid: true,
      usingDefault: false,
    });
    expect(parseGitTimeoutSeconds(String(MAX_GIT_TIMEOUT_SECONDS))).toMatchObject({
      seconds: MAX_GIT_TIMEOUT_SECONDS,
      valid: true,
      usingDefault: false,
    });
  });

  it("falls back to default for non-integer / non-numeric", () => {
    expect(parseGitTimeoutSeconds("abc")).toMatchObject({
      seconds: DEFAULT_GIT_TIMEOUT_SECONDS,
      valid: false,
      usingDefault: true,
      raw: "abc",
    });
    expect(parseGitTimeoutSeconds("12.5")).toMatchObject({
      seconds: DEFAULT_GIT_TIMEOUT_SECONDS,
      valid: false,
      usingDefault: true,
    });
    expect(parseGitTimeoutSeconds("NaN")).toMatchObject({
      valid: false,
      usingDefault: true,
    });
  });

  it("falls back to default for out-of-range values", () => {
    expect(parseGitTimeoutSeconds("0")).toMatchObject({
      seconds: DEFAULT_GIT_TIMEOUT_SECONDS,
      valid: false,
      usingDefault: true,
    });
    expect(parseGitTimeoutSeconds("-5")).toMatchObject({
      valid: false,
      usingDefault: true,
    });
    expect(parseGitTimeoutSeconds(String(MAX_GIT_TIMEOUT_SECONDS + 1))).toMatchObject({
      seconds: DEFAULT_GIT_TIMEOUT_SECONDS,
      valid: false,
      usingDefault: true,
    });
  });

  it("respects custom default parameter", () => {
    expect(parseGitTimeoutSeconds(undefined, 30)).toMatchObject({
      seconds: 30,
      usingDefault: true,
    });
    // 用户值有效则忽略 default 参数
    expect(parseGitTimeoutSeconds("45", 30)).toMatchObject({
      seconds: 45,
      usingDefault: false,
    });
    // 用户值非法时回退到自定义 default
    expect(parseGitTimeoutSeconds("abc", 30)).toMatchObject({
      seconds: 30,
      usingDefault: true,
    });
  });
});

describe("normalizeOptionalConfigField", () => {
  it("returns fallback (default empty string) when value is undefined", () => {
    expect(normalizeOptionalConfigField(undefined, { label: "x" })).toBe("");
  });

  it("returns fallback (default empty string) when value is null", () => {
    expect(normalizeOptionalConfigField(null, { label: "x" })).toBe("");
  });

  it("returns fallback when value is not a string (number / boolean / object)", () => {
    expect(normalizeOptionalConfigField(123, { label: "x" })).toBe("");
    expect(normalizeOptionalConfigField(true, { label: "x" })).toBe("");
    expect(normalizeOptionalConfigField({}, { label: "x" })).toBe("");
  });

  it("uses explicit fallback when value is missing", () => {
    expect(
      normalizeOptionalConfigField(undefined, { label: "x", fallback: "FB" }),
    ).toBe("FB");
    expect(
      normalizeOptionalConfigField(42, { label: "x", fallback: "FB" }),
    ).toBe("FB");
  });

  it("returns empty string as-is (treated as 'do not pass to SDK/CLI')", () => {
    expect(normalizeOptionalConfigField("", { label: "x" })).toBe("");
    expect(
      normalizeOptionalConfigField("", { label: "x", fallback: "FB" }),
    ).toBe("");
  });

  it("returns value as-is when it is a normal non-default string", () => {
    expect(normalizeOptionalConfigField("high", { label: "x" })).toBe("high");
    expect(
      normalizeOptionalConfigField("claude-sonnet-4-6", { label: "x" }),
    ).toBe("claude-sonnet-4-6");
  });

  it("preserves surrounding whitespace (trim handled by callers)", () => {
    expect(normalizeOptionalConfigField("  high  ", { label: "x" })).toBe(
      "  high  ",
    );
  });

  it("treats 'default' (any case, with whitespace) as empty string and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(normalizeOptionalConfigField("default", { label: "x" })).toBe("");
      expect(normalizeOptionalConfigField("DEFAULT", { label: "x" })).toBe("");
      expect(normalizeOptionalConfigField("Default", { label: "x" })).toBe("");
      expect(normalizeOptionalConfigField("  default  ", { label: "x" })).toBe(
        "",
      );
      expect(warn).toHaveBeenCalledTimes(4);
      const msg = String(warn.mock.calls[0]?.[0] ?? "");
      expect(msg).toContain("已废弃");
      expect(msg).toContain("x");
    } finally {
      warn.mockRestore();
    }
  });

  it("ignores fallback for 'default' (still returns empty string)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        normalizeOptionalConfigField("default", {
          label: "x",
          fallback: "FB",
        }),
      ).toBe("");
    } finally {
      warn.mockRestore();
    }
  });

  it("does NOT treat substrings like 'default-foo' as the deprecated literal", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        normalizeOptionalConfigField("default-foo", { label: "x" }),
      ).toBe("default-foo");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("GIT timeout constants", () => {
  it("DEFAULT_GIT_TIMEOUT_SECONDS is 180", () => {
    expect(DEFAULT_GIT_TIMEOUT_SECONDS).toBe(180);
  });

  it("MIN < DEFAULT < MAX", () => {
    expect(MIN_GIT_TIMEOUT_SECONDS).toBeGreaterThan(0);
    expect(MIN_GIT_TIMEOUT_SECONDS).toBeLessThan(DEFAULT_GIT_TIMEOUT_SECONDS);
    expect(DEFAULT_GIT_TIMEOUT_SECONDS).toBeLessThan(MAX_GIT_TIMEOUT_SECONDS);
  });
});

describe("autoDetectCursorPath", () => {
  it("Windows 优先返回 LocalAppData 默认安装路径（agent.cmd 存在）", () => {
    const calls: string[] = [];
    const result = autoDetectCursorPath({
      platform: "win32",
      localAppData: "C:\\Users\\u\\AppData\\Local",
      existsSync: (p) => {
        calls.push(p);
        return p.endsWith("agent.cmd");
      },
      whichSync: () => {
        throw new Error("不该走 PATH 查找");
      },
    });
    expect(result).toMatch(/cursor-agent[\\/]agent\.cmd$/);
    // 至少检查过一次默认安装路径
    expect(calls.some((c) => c.endsWith("agent.cmd"))).toBe(true);
  });

  it("Windows 但 LocalAppData 不存在 → 退回 whichSync(cursor-agent)", () => {
    const result = autoDetectCursorPath({
      platform: "win32",
      localAppData: "C:\\Users\\u\\AppData\\Local",
      existsSync: () => false,
      whichSync: (cmd) => (cmd === "cursor-agent" ? "C:\\tools\\cursor-agent.exe" : null),
    });
    expect(result).toBe("C:\\tools\\cursor-agent.exe");
  });

  it("非 Windows 跳过 LocalAppData，直接用 whichSync 查 cursor-agent → agent", () => {
    const tried: string[] = [];
    const result = autoDetectCursorPath({
      platform: "linux",
      localAppData: undefined,
      existsSync: () => {
        throw new Error("非 Windows 不应该 stat LocalAppData");
      },
      whichSync: (cmd) => {
        tried.push(cmd);
        return cmd === "agent" ? "/usr/local/bin/agent" : null;
      },
    });
    expect(result).toBe("/usr/local/bin/agent");
    expect(tried).toEqual(["cursor-agent", "agent"]);
  });

  it("全部命中失败时返回 null（不抛、由调用方决定留空）", () => {
    const result = autoDetectCursorPath({
      platform: "darwin",
      localAppData: undefined,
      existsSync: () => false,
      whichSync: () => null,
    });
    expect(result).toBeNull();
  });
});

describe("autoDetectCodexPath", () => {
  it("命中 PATH 中的 codex → 返回绝对路径", () => {
    const result = autoDetectCodexPath({
      whichSync: (cmd) => (cmd === "codex" ? "/usr/local/bin/codex" : null),
    });
    expect(result).toBe("/usr/local/bin/codex");
  });

  it("PATH 中没有 codex → 返回 null", () => {
    const result = autoDetectCodexPath({ whichSync: () => null });
    expect(result).toBeNull();
  });
});

describe("readToolCliPath", () => {
  it("优先返回新字段 path（command 同时存在也忽略）", () => {
    const onLegacy = vi.fn();
    expect(
      readToolCliPath(
        { path: "/new/path", command: "/old/cmd" },
        { label: "cursor", onLegacyField: onLegacy },
      ),
    ).toBe("/new/path");
    expect(onLegacy).not.toHaveBeenCalled();
  });

  it("仅有旧字段 command 时 → 用 command 的值并触发 onLegacyField 回调", () => {
    const onLegacy = vi.fn();
    expect(
      readToolCliPath(
        { command: "/old/cmd" },
        { label: "codex", onLegacyField: onLegacy },
      ),
    ).toBe("/old/cmd");
    expect(onLegacy).toHaveBeenCalledWith("codex", "/old/cmd");
  });

  it("path 为空字符串 / 全空白 → 视作未填，回退到 command", () => {
    const onLegacy = vi.fn();
    expect(
      readToolCliPath(
        { path: "  ", command: "/fallback" },
        { label: "cursor", onLegacyField: onLegacy },
      ),
    ).toBe("/fallback");
    expect(onLegacy).toHaveBeenCalledTimes(1);
  });

  it("两边都空 / undefined → 返回 ''，不触发回调", () => {
    const onLegacy = vi.fn();
    expect(readToolCliPath(undefined, { label: "x", onLegacyField: onLegacy })).toBe("");
    expect(readToolCliPath({}, { label: "x", onLegacyField: onLegacy })).toBe("");
    expect(
      readToolCliPath({ path: "", command: "" }, { label: "x", onLegacyField: onLegacy }),
    ).toBe("");
    expect(onLegacy).not.toHaveBeenCalled();
  });

  it("非字符串字段 → 当作未填", () => {
    expect(
      readToolCliPath({ path: 42, command: null } as unknown as { path?: unknown }, {
        label: "cursor",
      }),
    ).toBe("");
  });
});

describe("test environment side-effects (regression guard)", () => {
  // 历史 bug：跑单测会让仓库根目录"自己长出" config.json——
  // src/config.ts 顶层执行的 loadConfig() 在生产环境下会自动把
  // config.sample.json 复制成 config.json。这一行为不应在测试环境发生：
  // (1) 单测不应改动工作区文件；
  // (2) 误生成的 config.json 会污染 git status，干扰真实改动的提交。
  it("仅 import config 模块不会让仓库根目录自动生成 config.json", async () => {
    // 这里通过 import.meta.url 反推项目根目录，避免依赖 PROJECT_ROOT（后者来自 config.ts）。
    const projectRoot = join(
      new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "..",
      "..",
    );
    const configJsonPath = join(projectRoot, "config.json");
    const sampleExists = existsSync(join(projectRoot, "config.sample.json"));
    expect(sampleExists).toBe(true);

    const existedBefore = existsSync(configJsonPath);

    // 触发 config.ts 顶层副作用（其它单测也会通过 session.ts/adapters/* 间接 import 它，
    // 这里直接 import 模拟最坏情况）。
    await import("../config.ts");

    const existsAfter = existsSync(configJsonPath);
    // 如果 import 之前就不存在，import 之后也不应该被创建出来。
    if (!existedBefore) {
      expect(existsAfter).toBe(false);
    } else {
      expect(existsAfter).toBe(true);
    }
  });
});
