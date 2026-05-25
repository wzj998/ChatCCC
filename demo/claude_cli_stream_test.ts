/**
 * 测试 Claude CLI 流式输出，对比 SDK 方案。
 *
 * 用法：
 *   npx tsx demo/claude_cli_stream_test.ts
 *   npx tsx demo/claude_cli_stream_test.ts "你的提示词"
 *
 * 关键 CLI 参数：
 *   -p --verbose --output-format stream-json --include-partial-messages
 *   --no-session-persistence --permission-mode bypassPermissions
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// ============================================================
// 类型定义（对应 stream-json 输出格式）
// ============================================================

interface SystemInit {
  type: "system";
  subtype: "init";
  session_id: string;
  model: string;
  cwd: string;
  tools: string[];
  claude_code_version: string;
}

interface SystemStatus {
  type: "system";
  subtype: "status";
  status: string;
  session_id: string;
}

interface StreamEventMessageStart {
  type: "stream_event";
  event: { type: "message_start"; message: { model: string; id: string; usage: unknown } };
  session_id: string;
  ttft_ms?: number;
}

interface ContentBlockStart {
  type: "stream_event";
  event: { type: "content_block_start"; content_block: { type: string; [k: string]: unknown }; index: number };
  session_id: string;
}

interface ContentBlockDelta {
  type: "stream_event";
  event: {
    type: "content_block_delta";
    delta: { type: string; [k: string]: unknown };
    index: number;
  };
  session_id: string;
}

interface ContentBlockStop {
  type: "stream_event";
  event: { type: "content_block_stop"; index: number };
  session_id: string;
}

interface MessageDelta {
  type: "stream_event";
  event: {
    type: "message_delta";
    delta: { stop_reason: string };
    usage: { output_tokens: number; input_tokens: number };
  };
  session_id: string;
}

interface MessageStop {
  type: "stream_event";
  event: { type: "message_stop" };
  session_id: string;
}

interface AssistantMessage {
  type: "assistant";
  message: {
    model: string;
    id: string;
    role: string;
    type: string;
    content: Array<{ type: string; [k: string]: unknown }>;
    usage: { input_tokens: number; output_tokens: number };
  };
  session_id: string;
}

interface ResultEvent {
  type: "result";
  subtype: "success" | "error";
  is_error: boolean;
  result: string;
  stop_reason: string;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  total_cost_usd: number;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number };
  session_id: string;
}

type StreamLine =
  | SystemInit
  | SystemStatus
  | StreamEventMessageStart
  | ContentBlockStart
  | ContentBlockDelta
  | ContentBlockStop
  | MessageDelta
  | MessageStop
  | AssistantMessage
  | ResultEvent;

// ============================================================
// CLI 参数
// ============================================================

const CLI_PATH = "claude";
const CLI_ARGS = [
  "-p",
  "--verbose",
  "--output-format", "stream-json",
  "--include-partial-messages",
  "--no-session-persistence",
  "--permission-mode", "bypassPermissions",
];

// 可选：限制费用
if (process.env.MAX_BUDGET_USD) {
  CLI_ARGS.push("--max-budget-usd", process.env.MAX_BUDGET_USD);
}

// ============================================================
// 辅助函数
// ============================================================

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function colorize(text: string, code: number): string {
  return `\x1b[${code}m${text}\x1b[0m`;
}

// ============================================================
// 主流程
// ============================================================

async function main(): Promise<void> {
  const prompt = process.argv[2] || "请用中文写一首关于编程的五言绝句，包含注释。";
  console.error(colorize("=== Claude CLI 流式输出测试 ===", 1));
  console.error(colorize(`提示词: ${prompt}`, 36));
  console.error(colorize(`CLI 参数: ${CLI_ARGS.join(" ")}`, 36));
  console.error("");

  const startTime = Date.now();
  const cli = spawn(CLI_PATH, [...CLI_ARGS, prompt], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  const rl = createInterface({ input: cli.stdout! });

  // 统计
  let ttftMs: number | undefined;
  let firstTextTs: number | undefined;
  let totalTextChars = 0;
  let totalThinkingChars = 0;
  let currentBlockType = "";
  const blockCharCounts: Record<string, number> = {};
  let finalResult: ResultEvent | null = null;
  let sessionId = "";

  console.error(colorize("--- 流式输出开始 ---\n", 33));

  // 标记是否开始输出正文（正文前先打印 thinking）
  let thinkingPrinted = false;

  for await (const line of rl) {
    if (!line.trim()) continue;

    let parsed: StreamLine;
    try {
      parsed = JSON.parse(line);
    } catch {
      console.error(colorize(`[JSON parse error] ${line.slice(0, 120)}`, 31));
      continue;
    }

    switch (parsed.type) {
      // --- System events ---
      case "system": {
        if (parsed.subtype === "init") {
          sessionId = parsed.session_id;
          console.error(colorize(`[init] session=${sessionId}  model=${parsed.model}  version=${parsed.claude_code_version}`, 90));
        } else if (parsed.subtype === "status") {
          console.error(colorize(`[status] ${parsed.status}`, 90));
        }
        break;
      }

      // --- Stream events ---
      case "stream_event": {
        const evt = parsed.event;
        switch (evt.type) {
          case "message_start": {
            ttftMs = parsed.ttft_ms;
            console.error(colorize(`[message_start] model=${evt.message.model}  ttft=${parsed.ttft_ms ?? "?"}ms`, 90));
            break;
          }
          case "content_block_start": {
            currentBlockType = evt.content_block.type;
            blockCharCounts[currentBlockType] = 0;
            if (currentBlockType !== "thinking") {
              // 非 thinking 块开始时换行标记
              if (thinkingPrinted && currentBlockType === "text") {
                console.error(colorize("\n--- 正文 ---", 36));
              }
            }
            break;
          }
          case "content_block_delta": {
            const delta = evt.delta;
            if (delta.type === "text_delta" && typeof delta.text === "string") {
              if (firstTextTs === undefined) firstTextTs = Date.now();
              process.stdout.write(delta.text);
              totalTextChars += delta.text.length;
              blockCharCounts[currentBlockType] = (blockCharCounts[currentBlockType] ?? 0) + delta.text.length;
            } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
              if (!thinkingPrinted) {
                console.error(colorize("--- 思考过程 ---", 36));
                thinkingPrinted = true;
              }
              console.error(colorize(delta.thinking, 90));
              totalThinkingChars += delta.thinking.length;
              blockCharCounts[currentBlockType] = (blockCharCounts[currentBlockType] ?? 0) + delta.thinking.length;
            } else if (delta.type === "signature_delta") {
              // 签名 delta，通常为空，忽略
            } else if (delta.type === "tool_use_delta") {
              // TODO: 工具调用 delta 处理
            } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
              process.stdout.write(colorize(delta.partial_json, 33));
            }
            break;
          }
          case "content_block_stop": {
            // 块结束
            break;
          }
          case "message_delta": {
            console.error(colorize(
              `\n[message_delta] stop_reason=${evt.delta.stop_reason}  input=${evt.usage.input_tokens}  output=${evt.usage.output_tokens}`,
              90,
            ));
            break;
          }
          case "message_stop": {
            break;
          }
        }
        break;
      }

      // --- Assistant message (完整消息快照) ---
      case "assistant": {
        // 这是完整的消息摘要，已经有了 text_delta，不需要重复输出
        break;
      }

      // --- Result ---
      case "result": {
        finalResult = parsed;
        break;
      }
    }
  }

  // 等待进程退出
  const exitCode = await new Promise<number | null>((resolve) => {
    cli.on("close", resolve);
  });

  // stderr
  let stderr = "";
  for await (const chunk of cli.stderr!) {
    stderr += chunk;
  }

  const elapsed = Date.now() - startTime;

  // ============================================================
  // 输出统计报告
  // ============================================================

  console.error(colorize("\n--- 统计报告 ---", 33));
  console.error(`CLI 版本:         ${colorize("2.1.126", 37)}`);
  console.error(`Session ID:       ${colorize(sessionId, 37)}`);
  console.error(`退出码:           ${colorize(String(exitCode), exitCode === 0 ? 32 : 31)}`);
  console.error(`总耗时:           ${colorize(formatDuration(elapsed), 37)}`);
  console.error(`TTFT:             ${colorize(ttftMs ? `${ttftMs}ms` : "N/A", 37)}`);

  if (firstTextTs && ttftMs !== undefined) {
    // 正文首字时间（从请求开始算）
    const startTs = startTime + ttftMs;
    console.error(`首字延迟(text):   ${colorize(`${firstTextTs - startTs}ms (从请求开始)`, 37)}`);
  }

  console.error("");
  console.error("--- 输出统计 ---");
  console.error(`正文字符数:       ${colorize(String(totalTextChars), 37)}`);
  console.error(`思考字符数:       ${colorize(String(totalThinkingChars), 37)}`);
  for (const [blockType, count] of Object.entries(blockCharCounts)) {
    console.error(`  ${blockType}: ${count} chars`);
  }

  if (finalResult) {
    console.error("");
    console.error("--- 费用与用量 ---");
    console.error(`API 耗时:         ${colorize(formatDuration(finalResult.duration_api_ms), 37)}`);
    console.error(`轮次:             ${colorize(String(finalResult.num_turns), 37)}`);
    console.error(`输入 tokens:      ${colorize(String(finalResult.usage.input_tokens), 37)}`);
    console.error(`输出 tokens:      ${colorize(String(finalResult.usage.output_tokens), 37)}`);
    console.error(`缓存读取 tokens:  ${colorize(String(finalResult.usage.cache_read_input_tokens), 37)}`);
    console.error(`费用 (USD):       ${colorize(`$${finalResult.total_cost_usd.toFixed(4)}`, finalResult.total_cost_usd > 0.1 ? 33 : 32)}`);
    console.error(`停止原因:         ${colorize(finalResult.stop_reason, 37)}`);
    console.error(`是否错误:         ${colorize(String(finalResult.is_error), finalResult.is_error ? 31 : 32)}`);
  }

  if (stderr.trim()) {
    console.error(colorize(`\n--- stderr ---\n${stderr.trim().slice(0, 2000)}`, 33));
  }

  if (exitCode !== 0) {
    process.exitCode = 1;
    console.error(colorize("\nCLI 进程异常退出", 31));
  } else if (finalResult?.is_error) {
    process.exitCode = 1;
    console.error(colorize(`\nAPI 返回错误: ${finalResult.result}`, 31));
  } else {
    console.error(colorize("\n测试完成 ✓", 32));
  }
}

main().catch((err) => {
  console.error(colorize(`\n测试脚本异常: ${err.message}`, 31));
  console.error(err.stack);
  process.exitCode = 1;
});