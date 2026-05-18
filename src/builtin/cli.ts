/**
 * builtin/cli.ts — ChatCCC 内置 Agent 终端 REPL
 *
 * 用法:
 *   npx tsx src/builtin/cli.ts
 *   npx tsx src/builtin/cli.ts --model deepseek-chat
 *   npx tsx src/builtin/cli.ts --cwd /path/to/project
 *
 * 环境变量:
 *   DEEPSEEK_API_KEY — DeepSeek API Key（必需）
 *   DEEPSEEK_BASE_URL — API 地址（可选，默认 https://api.deepseek.com/v1）
 */

import * as readline from "node:readline";
import * as process from "node:process";
import { ChatSession, type ChatSessionConfig, type ChatSessionOptions } from "./index.js";

// ---------------------------------------------------------------------------
// 命令行参数解析
// ---------------------------------------------------------------------------

function parseArgs(): { config: ChatSessionConfig; options: ChatSessionOptions } {
  const args = process.argv.slice(2);
  const config: ChatSessionConfig = {};
  const options: ChatSessionOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--model" && next) {
      config.model = next;
      i++;
    } else if (arg === "--base-url" && next) {
      config.baseURL = next;
      i++;
    } else if (arg === "--api-key" && next) {
      config.apiKey = next;
      i++;
    } else if (arg === "--cwd" && next) {
      options.cwd = next;
      i++;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return { config, options };
}

function printHelp(): void {
  console.log([
    "ChatCCC 内置 Agent 终端 REPL",
    "",
    "用法: npx tsx src/builtin/cli.ts [选项]",
    "",
    "选项:",
    "  --model <name>   模型名称（默认 deepseek-chat）",
    "  --base-url <url> API 地址（默认 https://api.deepseek.com/v1）",
    "  --api-key <key>  API Key（默认读 DEEPSEEK_API_KEY 环境变量）",
    "  --cwd <path>     工作目录",
    "  --help, -h       显示帮助",
    "",
    "环境变量:",
    "  DEEPSEEK_API_KEY   DeepSeek API Key",
    "  DEEPSEEK_BASE_URL  API 地址",
    "",
  ].join("\n"));
}

// ---------------------------------------------------------------------------
// ANSI 颜色
// ---------------------------------------------------------------------------

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
};

// ---------------------------------------------------------------------------
// 主程序
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { config, options } = parseArgs();

  // 环境变量回退
  if (!config.baseURL) config.baseURL = process.env.DEEPSEEK_BASE_URL;
  if (!config.apiKey) config.apiKey = process.env.DEEPSEEK_API_KEY;

  console.log(`${C.dim}ChatCCC 内置 Agent 原型${C.reset}`);
  console.log(`${C.dim}模型: ${config.model ?? "deepseek-chat"}${C.reset}`);
  if (options.cwd) {
    console.log(`${C.dim}目录: ${options.cwd}${C.reset}`);
  }
  console.log(`${C.dim}输入消息开始对话，Ctrl+C 中断当前回复，/exit 退出${C.reset}`);
  console.log("");

  let session: ChatSession;
  try {
    session = new ChatSession(config, options);
  } catch (err) {
    console.error(`${C.yellow}${(err as Error).message}${C.reset}`);
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.green}>${C.reset} `,
  });

  // 用于中断当前 LLM 调用的 AbortController
  let currentAbort: AbortController | null = null;

  rl.prompt();

  rl.on("line", async (line: string) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    // 特殊命令
    if (input === "/exit" || input === "/quit") {
      console.log(`${C.dim}再见${C.reset}`);
      rl.close();
      return;
    }

    if (input === "/clear") {
      session.reset();
      console.log(`${C.dim}会话已重置${C.reset}`);
      rl.prompt();
      return;
    }

    if (input === "/history") {
      console.log(`${C.dim}共 ${session.turnCount} 轮对话${C.reset}`);
      rl.prompt();
      return;
    }

    // 发送消息
    currentAbort = new AbortController();
    const signal = currentAbort.signal;

    try {
      let lastAccumulated = "";
      for await (const event of session.chat(input, signal)) {
        if (event.type === "text") {
          // 增量输出（仅在首次和行首时不换行）
          const newText = event.accumulated.slice(lastAccumulated.length);
          process.stdout.write(newText);
          lastAccumulated = event.accumulated;
        } else if (event.type === "done") {
          if (lastAccumulated) console.log("");
          console.log(`${C.dim}[完成]${C.reset}`);
        } else if (event.type === "error") {
          console.log(`\n${C.yellow}[错误] ${event.message}${C.reset}`);
        }
      }
    } catch (err) {
      console.log(`\n${C.yellow}[错误] ${(err as Error).message}${C.reset}`);
    } finally {
      currentAbort = null;
    }

    rl.prompt();
  });

  // Ctrl+C → 中断当前 LLM 调用（不退出程序）
  rl.on("SIGINT", () => {
    if (currentAbort) {
      console.log(`\n${C.yellow}[中断中...]${C.reset}`);
      currentAbort.abort();
      currentAbort = null;
    } else {
      console.log(`\n${C.dim}输入 /exit 退出${C.reset}`);
      rl.prompt();
    }
  });

  rl.on("close", () => {
    console.log("");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(`${C.yellow}启动失败: ${(err as Error).message}${C.reset}`);
  process.exit(1);
});