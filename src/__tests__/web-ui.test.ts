import { describe, it, expect } from "vitest";
import {
  PAGE_HTML,
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

  it("maps Cursor and Codex alternative models into agent config", () => {
    expect(
      unflattenConfig({
        CHATCCC_CURSOR_ALTERNATIVE_MODEL: "gpt-5.5-high",
        CHATCCC_CODEX_ALTERNATIVE_MODEL: "gpt-5.3-codex",
      }),
    ).toEqual({
      cursor: {
        alternativeModel: "gpt-5.5-high",
      },
      codex: {
        alternativeModel: "gpt-5.3-codex",
      },
    });
  });

  it("maps Chrome CDP guard fields into chromeDevtools config", () => {
    expect(
      unflattenConfig({
        CHATCCC_CHROME_DEVTOOLS_ENABLED: true,
        CHATCCC_CHROME_DEVTOOLS_PORT: "15166",
        CHATCCC_CHROME_DEVTOOLS_PATH: "C:/Program Files/Google/Chrome/Application/chrome.exe",
      }),
    ).toEqual({
      chromeDevtools: {
        enabled: true,
        port: 15166,
        chromePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
      },
    });
  });
});

describe("dashboard edit modal", () => {
  it("shows the edit modal and overlay when a section edit button is clicked", () => {
    expect(PAGE_HTML).toContain("function editSection(section)");
    expect(PAGE_HTML).toContain("document.getElementById('edit-modal').classList.remove('hidden');");
    expect(PAGE_HTML).toContain("document.getElementById('edit-overlay').classList.remove('hidden');");
  });

  it("uses plain alternative model labels for Cursor and Codex", () => {
    expect(PAGE_HTML).toContain("field-CHATCCC_CURSOR_ALTERNATIVE_MODEL");
    expect(PAGE_HTML).toContain("field-CHATCCC_CODEX_ALTERNATIVE_MODEL");
    expect(PAGE_HTML).toContain("备选模型");
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
