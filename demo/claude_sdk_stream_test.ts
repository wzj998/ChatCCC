import {
  unstable_v2_createSession,
  type SDKSessionOptions,
} from "@anthropic-ai/claude-agent-sdk";

type ClaudeSdkSessionOptions = Omit<SDKSessionOptions, "model"> & {
  model?: string;
  autoCompactEnabled?: boolean;
  maxTurns?: number;
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

  const options: ClaudeSdkSessionOptions = {
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    settingSources: ["user", "project", "local"],
    autoCompactEnabled: true,
    maxTurns: 0,
  };
  if (process.env.CLAUDE_MODEL?.trim()) {
    options.model = process.env.CLAUDE_MODEL.trim();
  }
  const session = unstable_v2_createSession(options as SDKSessionOptions);

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
