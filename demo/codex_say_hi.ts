/**
 * 命令行对 Codex CLI 说「你好」，并把流式正文打印到 stdout。
 *
 *   npm run demo:codex-hi
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { getDefaultCwd } from "../src/config.ts";

// ---------------------------------------------------------------------------
// Codex JSONL 事件类型
// ---------------------------------------------------------------------------

interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number;
    status?: string;
  };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
}

async function* readJsonLines(proc: ChildProcess): AsyncGenerator<CodexEvent> {
  const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as CodexEvent;
    } catch {
      // 非 JSON 行静默跳过（如 "Reading prompt from stdin..."）
    }
  }
}

function spawnCodex(
  args: string[],
  cwd: string,
  stdinText?: string,
): ChildProcess {
  const proc = spawn("codex", args, {
    cwd,
    stdio: [stdinText !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: true,
  });

  let stderr = "";
  proc.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  proc.on("close", (code) => {
    if (code !== 0 && stderr.trim()) {
      console.error(`[codex stderr] exit=${code}: ${stderr.trim().slice(0, 2000)}`);
    }
  });

  if (stdinText !== undefined) {
    proc.stdin!.write(stdinText);
    proc.stdin!.end();
  }
  return proc;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const BASE_ARGS = [
  "exec",
  "--json",
  "--dangerously-bypass-approvals-and-sandbox",
  "--skip-git-repo-check",
];

async function main(): Promise<void> {
  const cwd = await getDefaultCwd();
  console.error(`[codex_say_hi] cwd=${cwd}\n`);

  // ---- Turn 1: say hi ----
  console.error("--- Turn 1: 你好 ---");
  let threadId: string | undefined;

  const proc1 = spawnCodex([...BASE_ARGS, "-C", cwd, "-"], cwd, "你好");
  for await (const evt of readJsonLines(proc1)) {
    if (evt.type === "thread.started" && evt.thread_id) {
      threadId = evt.thread_id;
      console.error(`[codex_say_hi] thread_id=${threadId}`);
    }

    if (evt.type === "item.completed" && evt.item?.type === "agent_message") {
      console.log(evt.item.text ?? "");
    }

    if (evt.type === "item.started" && evt.item?.type === "command_execution") {
      console.error(`  [工具] ${evt.item.command}`);
    }

    if (evt.type === "item.completed" && evt.item?.type === "command_execution") {
      const exit = evt.item.exit_code === 0 ? "OK" : `FAIL(${evt.item.exit_code})`;
      const output = (evt.item.aggregated_output ?? "").slice(0, 300);
      console.error(`  [结果] ${exit}: ${output}`);
    }

    if (evt.type === "turn.completed" && evt.usage) {
      console.error(
        `  [用量] in=${evt.usage.input_tokens} out=${evt.usage.output_tokens}`
      );
    }
  }

  if (!threadId) {
    console.error("[codex_say_hi] 失败: 未获取到 thread_id");
    process.exit(1);
  }

  // ---- Turn 2: resume and ask follow-up ----
  console.error("\n--- Turn 2: 刚才说了什么？ ---");

  // resume 子命令不接受 -C（cwd 继承自原始会话）
  const proc2 = spawnCodex(
    [...BASE_ARGS, "resume", threadId, "-"],
    cwd,
    "刚才说了什么？",
  );
  for await (const evt of readJsonLines(proc2)) {
    if (evt.type === "item.completed" && evt.item?.type === "agent_message") {
      console.log(evt.item.text ?? "");
    }

    if (evt.type === "item.completed" && evt.item?.type === "command_execution") {
      const exit = evt.item.exit_code === 0 ? "OK" : `FAIL(${evt.item.exit_code})`;
      console.error(`  [工具结果] ${exit}`);
    }

    if (evt.type === "turn.completed" && evt.usage) {
      console.error(
        `  [用量] in=${evt.usage.input_tokens} out=${evt.usage.output_tokens}`
      );
    }
  }

  console.error("\n[codex_say_hi] 完成");
}

main().catch((err) => {
  console.error("[codex_say_hi] 失败:", err);
  process.exitCode = 1;
});