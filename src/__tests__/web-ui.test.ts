import { describe, it, expect } from "vitest";
import {
  applyClaudeApiMode,
  chooseStartPath,
  detectClaudeApiMode,
} from "../web-ui.ts";

// ---------------------------------------------------------------------------
// detectClaudeApiMode — 加载已有 config 时如何判定 UI 初始模式
// 契约：apiKey 或 baseUrl 任一非空（trim 后） → "thirdparty"，否则 "official"。
// ---------------------------------------------------------------------------

describe("detectClaudeApiMode", () => {
  it("两者都缺失 → official", () => {
    expect(detectClaudeApiMode(undefined)).toBe("official");
    expect(detectClaudeApiMode({})).toBe("official");
  });

  it("两者都为空字符串 → official", () => {
    expect(detectClaudeApiMode({ apiKey: "", baseUrl: "" })).toBe("official");
  });

  it("两者都全空白 → official", () => {
    expect(detectClaudeApiMode({ apiKey: "  ", baseUrl: "\t\n" })).toBe(
      "official",
    );
  });

  it("apiKey 非空 → thirdparty（即使 baseUrl 为空）", () => {
    expect(detectClaudeApiMode({ apiKey: "sk-x", baseUrl: "" })).toBe(
      "thirdparty",
    );
  });

  it("baseUrl 非空 → thirdparty（即使 apiKey 为空）", () => {
    expect(
      detectClaudeApiMode({ apiKey: "", baseUrl: "https://gw/anthropic" }),
    ).toBe("thirdparty");
  });

  it("两者都非空 → thirdparty", () => {
    expect(
      detectClaudeApiMode({
        apiKey: "sk-x",
        baseUrl: "https://gw/anthropic",
      }),
    ).toBe("thirdparty");
  });
});

// ---------------------------------------------------------------------------
// applyClaudeApiMode — 服务端写入前归一化扁平 vars
// 关键契约：
//   - mode=official 时即使 vars 不含这两个键，也要写入 ""（覆盖原 config.json）
//   - mode=thirdparty 时原样保留（包括前端传 ""）
//   - mode 未传 默认按 official 兌底（不保留可能误填的密钥）
// ---------------------------------------------------------------------------

describe("applyClaudeApiMode", () => {
  it("mode=official 时清空 CLAUDE_API_KEY / CLAUDE_BASE_URL（即使 vars 没传）", () => {
    const out = applyClaudeApiMode({ CHATCCC_APP_ID: "x" }, "official");
    expect(out).toEqual({
      CHATCCC_APP_ID: "x",
      CLAUDE_API_KEY: "",
      CLAUDE_BASE_URL: "",
    });
  });

  it("mode=official 时覆盖前端误传的非空 apiKey / baseUrl", () => {
    const out = applyClaudeApiMode(
      {
        CLAUDE_API_KEY: "sk-leftover",
        CLAUDE_BASE_URL: "https://leftover/anthropic",
        CHATCCC_APP_ID: "x",
      },
      "official",
    );
    expect(out.CLAUDE_API_KEY).toBe("");
    expect(out.CLAUDE_BASE_URL).toBe("");
    expect(out.CHATCCC_APP_ID).toBe("x");
  });

  it("mode=thirdparty 时原样保留前端值", () => {
    const out = applyClaudeApiMode(
      {
        CLAUDE_API_KEY: "sk-test",
        CLAUDE_BASE_URL: "https://gw/anthropic",
      },
      "thirdparty",
    );
    expect(out).toEqual({
      CLAUDE_API_KEY: "sk-test",
      CLAUDE_BASE_URL: "https://gw/anthropic",
    });
  });

  it("mode=thirdparty 时保留前端主动提交的 ''（允许局部清空）", () => {
    const out = applyClaudeApiMode(
      { CLAUDE_API_KEY: "", CLAUDE_BASE_URL: "https://gw/anthropic" },
      "thirdparty",
    );
    expect(out.CLAUDE_API_KEY).toBe("");
    expect(out.CLAUDE_BASE_URL).toBe("https://gw/anthropic");
  });

  it("mode 未传（undefined） → 按 official 兌底清空", () => {
    const out = applyClaudeApiMode(
      { CLAUDE_API_KEY: "sk-x" },
      undefined,
    );
    expect(out.CLAUDE_API_KEY).toBe("");
    expect(out.CLAUDE_BASE_URL).toBe("");
  });

  it("mode 是未知字符串 → 按 official 兌底清空", () => {
    const out = applyClaudeApiMode(
      { CLAUDE_API_KEY: "sk-x" },
      "garbage-mode",
    );
    expect(out.CLAUDE_API_KEY).toBe("");
    expect(out.CLAUDE_BASE_URL).toBe("");
  });

  it("不修改入参对象（返回新对象）", () => {
    const input = { CLAUDE_API_KEY: "sk-x" };
    const out = applyClaudeApiMode(input, "official");
    expect(input).toEqual({ CLAUDE_API_KEY: "sk-x" }); // 原对象未变
    expect(out).not.toBe(input);
  });
});

// ---------------------------------------------------------------------------
// chooseStartPath — /api/start 的路径选择
// 关键护栏：
//   - setup 模式（hasInplaceActivateHook=true）下 isServiceRunning 永远为 true
//     （setup 进程自己占着 PID 文件），必须无条件走 inplace；否则用户点
//     "保存并启动"将永远拿到 "Service is already running"。
//   - dashboard 模式 + service 已运行（通常就是当前进程自己）→ "reload"：
//     用户点"保存并启动"想让新 config 生效，但服务正在跑——不真重启，仅
//     调用 reloadConfigFromDisk() 刷新进程内 export let 常量。绝不能再
//     返回"already running"挡用户路。
//   - dashboard 模式 + service 未运行 → spawn 一个新的（旧 service 退出后场景）。
// ---------------------------------------------------------------------------

describe("chooseStartPath", () => {
  it("setup 模式（注入 inplace hook）→ inplace（不管 PID 文件状态）", () => {
    expect(
      chooseStartPath({
        hasInplaceActivateHook: true,
        isServiceRunning: true,
      }),
    ).toBe("inplace");
    expect(
      chooseStartPath({
        hasInplaceActivateHook: true,
        isServiceRunning: false,
      }),
    ).toBe("inplace");
  });

  it("dashboard 模式 + service 已运行 → reload（仅刷新 config，不真重启）", () => {
    expect(
      chooseStartPath({
        hasInplaceActivateHook: false,
        isServiceRunning: true,
      }),
    ).toBe("reload");
  });

  it("dashboard 模式 + service 未运行 → spawn", () => {
    expect(
      chooseStartPath({
        hasInplaceActivateHook: false,
        isServiceRunning: false,
      }),
    ).toBe("spawn");
  });
});
