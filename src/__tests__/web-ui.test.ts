import { describe, it, expect } from "vitest";
import {
  chooseStartPath,
  unflattenConfig,
} from "../web-ui.ts";

describe("unflattenConfig", () => {
  it("maps Claude subagent model into claude.subagentModel", () => {
    expect(
      unflattenConfig({
        CHATCCC_ANTHROPIC_MODEL: "claude-sonnet-4-6",
        CHATCCC_ANTHROPIC_SUBAGENT_MODEL: "claude-haiku-4-5-20251001",
      }),
    ).toEqual({
      claude: {
        model: "claude-sonnet-4-6",
        subagentModel: "claude-haiku-4-5-20251001",
      },
    });
  });

  it("maps Claude apiKey and baseUrl into claude config", () => {
    expect(
      unflattenConfig({
        CHATCCC_ANTHROPIC_API_KEY: "sk-test-key",
        CHATCCC_ANTHROPIC_BASE_URL: "https://api.example.com",
      }),
    ).toEqual({
      claude: {
        apiKey: "sk-test-key",
        baseUrl: "https://api.example.com",
      },
    });
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