import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// 关键：mock installer 模块，避免 /api/claude-sdk/install 触发真实 npm 下载（220MB）
const installClaudeSdkMock = vi.hoisted(() => vi.fn());
vi.mock("../claude-sdk-installer.ts", () => ({
  getClaudeSdkInstalledVersion: () => null,
  getLastInstallProgress: () => ({ phase: "idle", percent: 0, message: "" }),
  installClaudeSdk: installClaudeSdkMock,
  isClaudeSdkInstalled: () => false,
  isInstallRunning: () => false,
}));

import {
  AGENT_TEAM_PAGE_HTML,
  PAGE_HTML,
  chooseStartPath,
  createUiRouter,
  getRestartRequiredReasons,
  unflattenConfig,
} from "../web-ui.ts";

describe("Agent Team page", () => {
  it("adds a prominent global entry to the ChatCCC page", () => {
    expect(PAGE_HTML).toContain('href="/agent-team"');
    expect(PAGE_HTML).toContain('class="agent-team-entry"');
    expect(PAGE_HTML).toContain("Agent Team");
    expect(PAGE_HTML).toContain("linear-gradient");
  });

  it("contains only the Agent Team title as page content", () => {
    expect(AGENT_TEAM_PAGE_HTML).toContain("<title>Agent Team</title>");
    expect(AGENT_TEAM_PAGE_HTML).toContain("<h1>Agent Team</h1>");
    expect(AGENT_TEAM_PAGE_HTML).not.toContain("dashboard-view");
    expect(AGENT_TEAM_PAGE_HTML).not.toContain("wizard-view");
  });

  it("serves the Agent Team page from its own route", async () => {
    const server = createServer(createUiRouter());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/agent-team`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(AGENT_TEAM_PAGE_HTML);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });
});

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

  it("maps Cursor and Codex runtime settings into agent config", () => {
    expect(
      unflattenConfig({
        CHATCCC_CURSOR_ALTERNATIVE_MODEL: "gpt-5.5-high",
        CHATCCC_CODEX_ALTERNATIVE_MODEL: "gpt-5.3-codex",
        CHATCCC_CODEX_FAST_MODE: true,
      }),
    ).toEqual({
      cursor: {
        alternativeModel: "gpt-5.5-high",
      },
      codex: {
        alternativeModel: "gpt-5.3-codex",
        fastMode: true,
      },
    });
  });

  it("maps CCC Agent settings into ccc config", () => {
    expect(
      unflattenConfig({
        CHATCCC_CCC_ENABLED: true,
        CHATCCC_CCC_DEFAULT_AGENT: true,
        CHATCCC_CCC_API_KEY: "sk-test-ccc",
        CHATCCC_CCC_BASE_URL: "https://api.deepseek.com/v1",
        CHATCCC_CCC_MODEL: "deepseek-v4-flash",
        CHATCCC_CCC_ALTERNATIVE_MODEL: "deepseek-v4-pro",
        CHATCCC_CCC_EFFORT: "max",
      }),
    ).toEqual({
      ccc: {
        enabled: true,
        defaultAgent: true,
        DEEPSEEK_API_KEY: "sk-test-ccc",
        DEEPSEEK_BASE_URL: "https://api.deepseek.com/v1",
        model: "deepseek-v4-flash",
        alternativeModel: "deepseek-v4-pro",
        effort: "max",
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

  it("maps the Web UI startup preference into webUi config", () => {
    expect(
      unflattenConfig({
        CHATCCC_WEB_UI_OPEN_ON_START: false,
      }),
    ).toEqual({
      webUi: {
        openOnStart: false,
      },
    });
  });
});

describe("getRestartRequiredReasons", () => {
  const baseConfig = {
    feishu: { appId: "cli_old", appSecret: "secret_old" },
    platforms: {
      feishu: { enabled: true, platformType: "feishu" },
      ilink: { enabled: true, reuseTokenOnStart: true },
    },
    webUi: { openOnStart: true },
    chromeDevtools: { enabled: false, port: 15166, chromePath: "" },
    port: 18080,
    claude: {
      enabled: true,
      defaultAgent: true,
      model: "",
      subagentModel: "",
      effort: "",
      apiKey: "",
      baseUrl: "",
      maxTurn: 0,
    },
    cursor: {
      enabled: true,
      defaultAgent: false,
      path: "",
      model: "",
      alternativeModel: "",
      avatarBatteryMode: "apiPercent",
      onDemandMonthlyBudget: 1000,
    },
    codex: {
      enabled: true,
      defaultAgent: false,
      path: "",
      model: "",
      alternativeModel: "",
      effort: "",
      fastMode: false,
    },
    ccc: {
      enabled: true,
      defaultAgent: false,
      DEEPSEEK_API_KEY: "sk-test-ccc",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com/v1",
      model: "deepseek-v4-pro",
      alternativeModel: "",
    },
  };

  it("does not require restart for agent and Chrome runtime settings", () => {
    expect(
      getRestartRequiredReasons(baseConfig, {
        ...baseConfig,
        chromeDevtools: { enabled: true, port: 15167, chromePath: "C:/Chrome/chrome.exe" },
        claude: { ...baseConfig.claude, model: "claude-sonnet", apiKey: "sk-test", maxTurn: 8 },
        cursor: { ...baseConfig.cursor, path: "C:/cursor-agent.cmd", model: "cursor-model" },
        codex: {
          ...baseConfig.codex,
          path: "C:/codex.cmd",
          model: "gpt-5.3-codex",
          effort: "high",
          fastMode: true,
        },
      }),
    ).toEqual([]);
  });

  it("requires restart for port, Feishu credentials, platform type, and platform lifecycle", () => {
    expect(
      getRestartRequiredReasons(baseConfig, {
        ...baseConfig,
        feishu: { appId: "cli_new", appSecret: "secret_new" },
        platforms: {
          feishu: { enabled: false, platformType: "lark" },
          ilink: { enabled: false, reuseTokenOnStart: false },
        },
        port: 18081,
      }),
    ).toEqual([
      "port",
      "feishu.appId",
      "feishu.appSecret",
      "platforms.feishu.platformType",
      "platforms.feishu.enabled",
      "platforms.ilink.enabled",
      "platforms.ilink.reuseTokenOnStart",
    ]);
  });
});

describe("dashboard edit modal", () => {
  it("keeps the embedded dashboard script syntactically valid", () => {
    const script = PAGE_HTML.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script ?? "")).not.toThrow();
  });

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

  it("shows CCC Agent in the wizard and dashboard with model switching fields", () => {
    expect(PAGE_HTML).toContain('id="agent-card-ccc"');
    expect(PAGE_HTML).toContain('id="agent-enable-ccc"');
    expect(PAGE_HTML).toContain('id="agent-default-ccc"');
    expect(PAGE_HTML).toContain('id="field-CHATCCC_CCC_MODEL"');
    expect(PAGE_HTML).toContain('id="field-CHATCCC_CCC_ALTERNATIVE_MODEL"');
    expect(PAGE_HTML).toContain('id="field-CHATCCC_CCC_EFFORT"');
    expect(PAGE_HTML).toContain('id="dash-ccc"');
    expect(PAGE_HTML).toContain("editSection('ccc')");
  });

  it("shows config effect scope hints", () => {
    expect(PAGE_HTML).toContain("生效范围：保存后下一条消息或下个新会话生效");
    expect(PAGE_HTML).toContain("生效范围：飞书开关、App ID、App Secret 或平台类型变更需要重启 ChatCCC");
  });

  it("shows the Codex Fast mode switch in both the wizard and dashboard", () => {
    expect(PAGE_HTML).toContain('id="field-CHATCCC_CODEX_FAST_MODE"');
    expect(PAGE_HTML).toContain('id="cfg-CODEX_FAST_MODE"');
    expect(PAGE_HTML).toContain("Fast 模式");
  });

  it("shows the Web UI startup switch in both the wizard and dashboard", () => {
    expect(PAGE_HTML).toContain('id="field-CHATCCC_WEB_UI_OPEN_ON_START"');
    expect(PAGE_HTML).toContain('id="cfg-WEB_UI_OPEN_ON_START"');
    expect(PAGE_HTML).toContain("editSection('webUi')");
    expect(PAGE_HTML).toContain("下次直接启动生效；内部重启始终不打开");
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

// ---------------------------------------------------------------------------
// Claude Code 引擎（Agent SDK）按需安装路由
// 护栏：/api/claude-sdk/status 与 /api/claude-sdk/install 必须可路由，且
//   install 在“正在安装”时返回 alreadyRunning 而不是再起一个任务。
// ---------------------------------------------------------------------------

describe("Claude SDK install routes", () => {
  beforeEach(() => {
    installClaudeSdkMock.mockReset();
    installClaudeSdkMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    installClaudeSdkMock.mockReset();
  });

  it("GET /api/claude-sdk/status 返回安装状态与进度", async () => {
    const server = createServer(createUiRouter());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/claude-sdk/status`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(typeof body.installed).toBe("boolean");
      expect(typeof body.running).toBe("boolean");
      expect(body.progress).toBeDefined();
      expect(body.progress.phase).toBeDefined();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });

  it("POST /api/claude-sdk/install 启动后台安装（不真实下载）", async () => {
    const server = createServer(createUiRouter());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/claude-sdk/install`, { method: "POST" });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(installClaudeSdkMock).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });

  it("设置页 HTML 包含 Claude 引擎安装 UI（进度条 + 按钮）", () => {
    expect(PAGE_HTML).toContain("claude-engine-install-btn");
    expect(PAGE_HTML).toContain("claude-engine-progress-bar");
    expect(PAGE_HTML).toContain("installClaudeEngine()");
    expect(PAGE_HTML).toContain("claudeEngineRefreshStatus");
  });

  it("设置页卡片顺序：CCC 置顶于 Claude 之前", () => {
    const cccIdx = PAGE_HTML.indexOf('id="agent-card-ccc"');
    const claudeIdx = PAGE_HTML.indexOf('id="agent-card-claude"');
    const cursorIdx = PAGE_HTML.indexOf('id="agent-card-cursor"');
    const codexIdx = PAGE_HTML.indexOf('id="agent-card-codex"');
    expect(cccIdx).toBeGreaterThan(-1);
    expect(claudeIdx).toBeGreaterThan(-1);
    expect(cursorIdx).toBeGreaterThan(-1);
    expect(codexIdx).toBeGreaterThan(-1);
    expect(cccIdx).toBeLessThan(claudeIdx);
    expect(claudeIdx).toBeLessThan(cursorIdx);
    expect(cursorIdx).toBeLessThan(codexIdx);
  });

  it("CCC 卡片文案强调 OpenAI 兼容（不限于 DeepSeek）", () => {
    expect(PAGE_HTML).toContain("OpenAI 兼容 API（不限于 DeepSeek）");
  });
});
