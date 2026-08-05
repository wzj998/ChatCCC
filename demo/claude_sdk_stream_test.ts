import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

// Claude Code 引擎（Agent SDK）不随 chatccc 安装：按需安装到
// ~/.chatccc/claude-sdk/ 后动态加载（与 src/claude-sdk-installer.ts 一致）。
const CLAUDE_SDK_ENTRY = join(
  homedir(),
  ".chatccc",
  "claude-sdk",
  "node_modules",
  "@anthropic-ai",
  "claude-agent-sdk",
  "sdk.mjs",
);

if (!existsSync(CLAUDE_SDK_ENTRY)) {
  console.error(
    "Claude Code 引擎（SDK）未安装。请在 chatccc 设置页「Claude Code」卡片点击「安装引擎」后重试。",
  );
  process.exit(1);
}

const sdk = (await import(pathToFileURL(CLAUDE_SDK_ENTRY).href)) as {
  unstable_v2_createSession(options: unknown): unknown;
};

// 本地最小类型（与 claude-adapter.ts 中的 ClaudeSdkSessionOptions 对齐）
type SdkSessionOptions = {
  permissionMode?: string;
  allowDangerouslySkipPermissions?: boolean;
  settingSources?: string[];
  autoCompactEnabled?: boolean;
  maxTurns?: number;
  model?: string;
  [key: string]: unknown;
};

type ClaudeSdkSessionLike = {
  send(text: string): Promise<void>;
  stream(): AsyncIterable<unknown>;
  close(): void;
};

type SdkMessageLike = {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: {
    content?: Array<{
      type: string;
      text?: string;
      thinking?: string;
      [key: string]: unknown;
    }>;
  };
  result?: string;
  is_error?: boolean;
  stop_reason?: string | null;
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function colorize(text: string, code: number): string {
  return `\x1b[${code}m${text}\x1b[0m`;
}

async function main(): Promise<void> {
  const prompt = process.argv[2] || "Please write a short Chinese poem about programming.";
  const startTime = Date.now();
  let sessionId = "";
  let totalTextChars = 0;
  let totalThinkingChars = 0;
  let finalResult: SdkMessageLike | null = null;

  console.error(colorize("=== Claude Agent SDK stream test ===", 1));
  console.error(colorize(`Prompt: ${prompt}`, 36));
  console.error("");

  const options: SdkSessionOptions = {
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    settingSources: ["user", "project", "local"],
    autoCompactEnabled: true,
    maxTurns: 0,
  };
  if (process.env.CLAUDE_MODEL?.trim()) {
    options.model = process.env.CLAUDE_MODEL.trim();
  }
  const session = sdk.unstable_v2_createSession(options) as ClaudeSdkSessionLike;

  try {
    await session.send(prompt);
    for await (const raw of session.stream()) {
      const parsed = raw as unknown as SdkMessageLike;
      if (parsed.session_id) sessionId = parsed.session_id;

      if (parsed.type === "system" && parsed.subtype === "init") {
        console.error(colorize(`[init] session=${sessionId}`, 90));
      }

      if (parsed.type === "assistant") {
        for (const block of parsed.message?.content ?? []) {
          if (block.type === "thinking" && block.thinking) {
            totalThinkingChars += block.thinking.length;
            console.error(colorize(block.thinking, 90));
          }
          if (block.type === "text" && block.text) {
            totalTextChars += block.text.length;
            process.stdout.write(block.text);
          }
        }
      }

      if (parsed.type === "result") {
        finalResult = parsed;
        break;
      }
    }
  } finally {
    session.close();
  }

  const elapsed = Date.now() - startTime;
  console.error(colorize("\n--- Report ---", 33));
  console.error(`Session ID:       ${colorize(sessionId || "N/A", 37)}`);
  console.error(`Elapsed:          ${colorize(formatDuration(elapsed), 37)}`);
  console.error(`Text chars:       ${colorize(String(totalTextChars), 37)}`);
  console.error(`Thinking chars:   ${colorize(String(totalThinkingChars), 37)}`);

  if (finalResult) {
    console.error(`API duration:     ${colorize(formatDuration(finalResult.duration_ms ?? 0), 37)}`);
    console.error(`Input tokens:     ${colorize(String(finalResult.usage?.input_tokens ?? "N/A"), 37)}`);
    console.error(`Output tokens:    ${colorize(String(finalResult.usage?.output_tokens ?? "N/A"), 37)}`);
    console.error(`Cache tokens:     ${colorize(String(finalResult.usage?.cache_read_input_tokens ?? "N/A"), 37)}`);
    console.error(`Cost USD:         ${colorize(String(finalResult.total_cost_usd ?? "N/A"), 37)}`);
    console.error(`Stop reason:      ${colorize(String(finalResult.stop_reason ?? "N/A"), 37)}`);
    console.error(`Is error:         ${colorize(String(finalResult.is_error), finalResult.is_error ? 31 : 32)}`);
  }

  if (finalResult?.is_error) {
    process.exitCode = 1;
    console.error(colorize(`\nSDK returned an error: ${finalResult.result ?? ""}`, 31));
  } else {
    console.error(colorize("\nSDK stream test completed", 32));
  }
}

main().catch((err) => {
  console.error(colorize(`\nSDK stream test failed: ${(err as Error).message}`, 31));
  console.error((err as Error).stack);
  process.exitCode = 1;
});
