import { describe, it, expect, beforeEach } from "vitest";

// 注意：这个测试文件是少数几个**故意**直接 import `../config.ts` 的地方
// （会触发 module-level loadConfig 副作用）。其它测试应优先 import
// config-utils.ts。这里因为要验证 export let 常量在 applyLoadedConfig
// 调用后能被刷新，没有更轻量的替代路径。
import {
  APP_ID,
  APP_SECRET,
  CHATCCC_PORT,
  CLAUDE_API_KEY,
  CLAUDE_BASE_URL,
  CLAUDE_EFFORT,
  CLAUDE_MODEL,
  CURSOR_AGENT_ARGS,
  CURSOR_AGENT_COMMAND,
  FEISHU_ENABLED,
  GIT_TIMEOUT_MS,
  GIT_TIMEOUT_SECONDS,
  ILINK_ENABLED,
  applyLoadedConfig,
  config,
  resolveDefaultAgentTool,
  type AppConfig,
} from "../config.ts";

// ---------------------------------------------------------------------------
// applyLoadedConfig — setup → service「在线切换」时刷新进程内 config 的核心机制
//
// 关键护栏：
//   1. 调用后 export let 的 APP_ID / APP_SECRET 等必须刷新到新值
//   2. config 这个 export 必须保持**同一个引用**（不能被替换），
//      否则 codex-adapter 等"直接 import config"的下游会拿不到新值
//   3. CHATCCC_PORT 不被 reload 改动（setup HTTP server 已经监听原端口，
//      原地切换复用同一 server，重新读端口只会引入混乱）
// ---------------------------------------------------------------------------

const baseAppConfig: AppConfig = {
  feishu: { appId: "INITIAL_APP", appSecret: "INITIAL_SECRET" },
  platforms: { feishu: { enabled: true }, ilink: { enabled: true } },
  port: 18080,
  gitTimeoutSeconds: 180,
  allowInterrupt: false,
  claude: {
    enabled: true,
    defaultAgent: true,
    model: "initial-model",
    effort: "initial-effort",
    apiKey: "sk-initial",
    baseUrl: "https://initial.gw/anthropic",
  },
  cursor: { enabled: true, defaultAgent: false, path: "/initial/cursor", model: "initial-cursor-model" },
  codex: { enabled: true, defaultAgent: false, path: "/initial/codex", model: "initial-codex-model", effort: "initial-codex-effort" },
};

// 把 module 状态抢救快照：每个 it 跑前重置回这个状态，避免污染相邻测试。
// 不直接用启动时的 config 引用做 snapshot——它可能已经被前一个 it 改写。
function resetToBaseline(): void {
  applyLoadedConfig(structuredClone(baseAppConfig));
}

beforeEach(() => {
  resetToBaseline();
});

describe("applyLoadedConfig — 刷新 export let 常量", () => {
  it("更新 APP_ID / APP_SECRET（飞书凭证）", () => {
    expect(APP_ID).toBe("INITIAL_APP");
    expect(APP_SECRET).toBe("INITIAL_SECRET");

    applyLoadedConfig({
      ...structuredClone(baseAppConfig),
      feishu: { appId: "NEW_APP_ID", appSecret: "NEW_APP_SECRET" },
    });

    // ES module live binding：测试模块顶层 import 的 APP_ID 会自动看到新值
    expect(APP_ID).toBe("NEW_APP_ID");
    expect(APP_SECRET).toBe("NEW_APP_SECRET");
  });

  it("更新 Claude 配置（model / effort / apiKey / baseUrl）", () => {
    applyLoadedConfig({
      ...structuredClone(baseAppConfig),
      claude: {
        enabled: true,
        defaultAgent: true,
        model: "deepseek-v4-pro",
        effort: "high",
        apiKey: "sk-newkey",
        baseUrl: "https://gw2.example/anthropic",
      },
    });

    expect(CLAUDE_MODEL).toBe("deepseek-v4-pro");
    expect(CLAUDE_EFFORT).toBe("high");
    expect(CLAUDE_API_KEY).toBe("sk-newkey");
    expect(CLAUDE_BASE_URL).toBe("https://gw2.example/anthropic");
  });

  it("更新 GIT_TIMEOUT_SECONDS 与 GIT_TIMEOUT_MS（毫秒派生值同步刷新）", () => {
    applyLoadedConfig({
      ...structuredClone(baseAppConfig),
      gitTimeoutSeconds: 240,
    });

    expect(GIT_TIMEOUT_SECONDS).toBe(240);
    // 派生值必须跟着更新，否则 /git 仍然按旧 timeout 运行
    expect(GIT_TIMEOUT_MS).toBe(240 * 1000);
  });

  it("更新平台开关（默认飞书和微信都开启）", () => {
    expect(FEISHU_ENABLED).toBe(true);
    expect(ILINK_ENABLED).toBe(true);

    applyLoadedConfig({
      ...structuredClone(baseAppConfig),
      platforms: { feishu: { enabled: false }, ilink: { enabled: true } },
    });

    expect(FEISHU_ENABLED).toBe(false);
    expect(ILINK_ENABLED).toBe(true);
  });

  it("CURSOR_AGENT_ARGS 跟随 cursor.model 重新解析", () => {
    applyLoadedConfig({
      ...structuredClone(baseAppConfig),
      cursor: { enabled: true, defaultAgent: false, path: "/x/cursor", model: "claude-3.7-sonnet" },
    });

    // CURSOR_AGENT_ARGS 是 ['-p', '--force', ..., '--model', 'claude-3.7-sonnet']
    expect(CURSOR_AGENT_ARGS).toContain("--model");
    expect(CURSOR_AGENT_ARGS).toContain("claude-3.7-sonnet");
  });

  it("cursor.model 留空时 CURSOR_AGENT_ARGS 不含 --model", () => {
    applyLoadedConfig({
      ...structuredClone(baseAppConfig),
      cursor: { enabled: true, defaultAgent: false, path: "/x/cursor", model: "" },
    });

    expect(CURSOR_AGENT_ARGS).not.toContain("--model");
  });

  it("CURSOR_AGENT_COMMAND 优先取 config.cursor.path", () => {
    applyLoadedConfig({
      ...structuredClone(baseAppConfig),
      cursor: { enabled: true, defaultAgent: false, path: "C:/custom/cursor.exe", model: "" },
    });

    expect(CURSOR_AGENT_COMMAND).toBe("C:/custom/cursor.exe");
  });

  it("不修改 CHATCCC_PORT（端口在 setup 切换时必须保持不变）", () => {
    const portBefore = CHATCCC_PORT;
    applyLoadedConfig({
      ...structuredClone(baseAppConfig),
      port: 19999,
    });
    // 重要：port 字段会刷到 config 对象上（见下个测试），但 CHATCCC_PORT 这个
    // 顶级 export 始终指向 chatccc 启动那一刻的端口，不允许在线切换中更换。
    expect(CHATCCC_PORT).toBe(portBefore);
  });
});

describe("applyLoadedConfig — config 对象引用契约", () => {
  it("config 引用保持不变（就地更新），但字段被刷新", () => {
    const refBefore = config;

    applyLoadedConfig({
      ...structuredClone(baseAppConfig),
      feishu: { appId: "REF_TEST_APP", appSecret: "REF_TEST_SECRET" },
      codex: { enabled: true, defaultAgent: false, path: "/refresh/codex", model: "fresh-model", effort: "low" },
    });

    // 必须是同一个引用：codex-adapter 等下游模块"直接 import config"，
    // 替换引用会破坏它们对 config.codex.* 的访问。
    expect(config).toBe(refBefore);
    expect(config.feishu.appId).toBe("REF_TEST_APP");
    expect(config.codex.path).toBe("/refresh/codex");
  });

  it("空 feishu 凭证也能正确刷入（向导回滚到空的反向场景）", () => {
    applyLoadedConfig({
      ...structuredClone(baseAppConfig),
      feishu: { appId: "", appSecret: "" },
    });
    expect(APP_ID).toBe("");
    expect(APP_SECRET).toBe("");
    expect(config.feishu.appId).toBe("");
  });
});

describe("resolveDefaultAgentTool", () => {
  it("优先使用显式 defaultAgent 且已启用的 Agent", () => {
    const cfg = structuredClone(baseAppConfig);
    cfg.claude.defaultAgent = false;
    cfg.cursor.defaultAgent = true;

    expect(resolveDefaultAgentTool(cfg)).toBe("cursor");
  });

  it("defaultAgent 指向未启用 Agent 时回退到第一个已启用 Agent", () => {
    const cfg = structuredClone(baseAppConfig);
    cfg.claude.enabled = false;
    cfg.claude.defaultAgent = true;
    cfg.cursor.defaultAgent = false;

    expect(resolveDefaultAgentTool(cfg)).toBe("cursor");
  });
});
