/**
 * Manual Codex app-server approval demo.
 *
 * Starts a real `codex app-server`, runs a real Codex turn in an isolated
 * workspace, answers approval requests with a selected decision, and logs all
 * JSON-RPC traffic for inspection.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";

import { killProcessTree } from "../../src/adapters/proc-tree-kill.ts";

type Decision = "accept" | "acceptForSession" | "decline" | "cancel";
type ScenarioDecision = Decision | "matrix";
type ApprovalPolicy = "untrusted" | "on-request" | "never";
type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

interface Options {
  decision: ScenarioDecision;
  timeoutMs: number;
  model: string | null;
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  cleanupWorkspace: boolean;
}

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface ApprovalRecord {
  method: string;
  requestId: number | string;
  decision: Decision;
  command?: string | null;
  cwd?: string | null;
  reason?: string | null;
  availableDecisions?: unknown;
  responsePayload: unknown;
}

interface ScenarioResult {
  decision: Decision;
  runDir: string;
  workspaceDir: string;
  approvalCount: number;
  approvalRecords: ApprovalRecord[];
  turnStatus: string | null;
  resultFileExists: boolean;
  resultFileText: string | null;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(__dirname, "runs");
const RESULT_FILE = "approval-result.txt";

function deferred<T>(): Deferred<T> {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (err: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    decision: "accept",
    timeoutMs: 180_000,
    model: null,
    // This demo validates the approval protocol first. On this Windows host,
    // Codex's workspace-write sandbox cannot spawn commands
    // (CreateProcessWithLogonW 1385), so the default uses full access while
    // `approvalPolicy=untrusted` still forces command review.
    sandbox: "danger-full-access",
    approvalPolicy: "untrusted",
    cleanupWorkspace: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    const takeValue = (name: string): string => {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : next;
      if (!value) throw new Error(`Missing value for ${name}`);
      if (!arg.includes("=")) i += 1;
      return value;
    };

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--decision" || arg.startsWith("--decision=")) {
      const value = takeValue("--decision") as ScenarioDecision;
      if (!["accept", "acceptForSession", "decline", "cancel", "matrix"].includes(value)) {
        throw new Error(`Unsupported --decision ${value}`);
      }
      options.decision = value;
    } else if (arg === "--timeout-ms" || arg.startsWith("--timeout-ms=")) {
      options.timeoutMs = Number(takeValue("--timeout-ms"));
      if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
        throw new Error("--timeout-ms must be a positive number");
      }
    } else if (arg === "--model" || arg.startsWith("--model=")) {
      options.model = takeValue("--model");
    } else if (arg === "--sandbox" || arg.startsWith("--sandbox=")) {
      const value = takeValue("--sandbox") as SandboxMode;
      if (!["read-only", "workspace-write", "danger-full-access"].includes(value)) {
        throw new Error(`Unsupported --sandbox ${value}`);
      }
      options.sandbox = value;
    } else if (arg === "--approval-policy" || arg.startsWith("--approval-policy=")) {
      const value = takeValue("--approval-policy") as ApprovalPolicy;
      if (!["untrusted", "on-request", "never"].includes(value)) {
        throw new Error(`Unsupported --approval-policy ${value}`);
      }
      options.approvalPolicy = value;
    } else if (arg === "--cleanup-workspace") {
      options.cleanupWorkspace = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`Usage:
  npm run demo:codex-app-server-approval -- [options]

Options:
  --decision <accept|acceptForSession|decline|cancel|matrix>
  --timeout-ms <ms>               Default: 180000
  --model <model>                 Optional app-server thread model override
  --sandbox <mode>                read-only | workspace-write | danger-full-access
                                  Default: danger-full-access for demo reliability
  --approval-policy <policy>      untrusted | on-request | never
  --cleanup-workspace             Remove the run folder after a successful scenario
`);
}

async function pickFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveOpen, rejectOpen) => {
    server.once("error", rejectOpen);
    server.listen(0, "127.0.0.1", resolveOpen);
  });

  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Failed to allocate a TCP port");
  }

  const port = address.port;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((err) => (err ? rejectClose(err) : resolveClose()));
  });
  return port;
}

function timestampForPath(): string {
  return new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .replace("Z", "");
}

async function waitForReady(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/readyz`;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return;
      lastError = new Error(`readyz returned HTTP ${resp.status}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(150);
  }

  throw new Error(`Timed out waiting for app-server readyz: ${String(lastError)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function logFrame(stream: WriteStream, direction: "in" | "out", payload: unknown): void {
  stream.write(
    `${JSON.stringify({ ts: new Date().toISOString(), direction, payload })}\n`,
  );
}

function closeStream(stream: WriteStream): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    stream.end((err?: Error | null) => {
      if (err) rejectClose(err);
      else resolveClose();
    });
  });
}

class JsonRpcWsClient {
  private nextId = 1;
  private pending = new Map<
    number | string,
    {
      method: string;
      resolve: (value: unknown) => void;
      reject: (err: unknown) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  onServerRequest?: (message: JsonRpcMessage) => Promise<void>;
  onNotification?: (message: JsonRpcMessage) => void;

  private constructor(
    private readonly ws: WebSocket,
    private readonly rawLog: WriteStream,
  ) {
    this.ws.on("message", (data) => {
      void this.handleMessage(data.toString());
    });
  }

  static async connect(url: string, rawLog: WriteStream): Promise<JsonRpcWsClient> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      ws.once("open", resolveOpen);
      ws.once("error", rejectOpen);
    });
    return new JsonRpcWsClient(ws, rawLog);
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;

    const payload = { method, id, params };
    logFrame(this.rawLog, "out", payload);
    this.ws.send(JSON.stringify(payload));

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method} response`));
      }, timeoutMs);
      timeout.unref?.();
      this.pending.set(id, { method, resolve, reject, timeout });
    });
  }

  respond(id: number | string, result: unknown): void {
    const payload = { id, result };
    logFrame(this.rawLog, "out", payload);
    this.ws.send(JSON.stringify(payload));
  }

  respondError(id: number | string, code: number, message: string): void {
    const payload = { id, error: { code, message } };
    logFrame(this.rawLog, "out", payload);
    this.ws.send(JSON.stringify(payload));
  }

  close(): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("WebSocket closed"));
    }
    this.pending.clear();
    this.ws.close();
  }

  private async handleMessage(raw: string): Promise<void> {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(raw) as JsonRpcMessage;
    } catch {
      console.error(`[app-server raw] ${raw}`);
      return;
    }

    logFrame(this.rawLog, "in", message);

    // JSON-RPC responses have an id and no method. Server-initiated approval
    // requests also have an id, but keep `method`, so they are handled below.
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined) && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(
          new Error(`${pending.method} failed: ${message.error.message ?? JSON.stringify(message.error)}`),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method && message.id !== undefined) {
      if (this.onServerRequest) {
        await this.onServerRequest(message);
      } else {
        this.respondError(message.id, -32601, `Unhandled server request ${message.method}`);
      }
      return;
    }

    if (message.method) {
      this.onNotification?.(message);
    }
  }
}

async function startAppServer(port: number, stderrPath: string): Promise<ChildProcess> {
  const stderrLog = createWriteStream(stderrPath, { flags: "a", encoding: "utf8" });
  const proc = spawn(
    "codex",
    ["app-server", "--listen", `ws://127.0.0.1:${port}`],
    {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // Windows needs shell resolution for the npm-installed codex shim.
      // killProcessTree in finally handles the extra cmd.exe/node wrapper.
      shell: true,
    },
  );

  proc.stdout?.on("data", (chunk: Buffer) => {
    stderrLog.write(`[stdout] ${chunk.toString()}`);
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderrLog.write(chunk.toString());
  });
  proc.on("close", (code, signal) => {
    stderrLog.write(`\n[app-server closed] code=${code} signal=${signal}\n`);
    stderrLog.end();
  });

  return proc;
}

function mapLegacyDecision(decision: Decision): unknown {
  switch (decision) {
    case "accept":
      return "approved";
    case "acceptForSession":
      return "approved_for_session";
    case "decline":
      return "denied";
    case "cancel":
      return "abort";
  }
}

function approvalResponseFor(method: string, decision: Decision): unknown {
  // Codex 0.130 can emit both the v2 approval methods and older legacy names.
  // The decision vocabulary differs, so keep the translation explicit.
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return { decision: mapLegacyDecision(decision) };
  }
  return { decision };
}

function isApprovalRequest(method: string): boolean {
  return [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "execCommandApproval",
    "applyPatchApproval",
  ].includes(method);
}

function extractApprovalRecord(
  message: JsonRpcMessage,
  decision: Decision,
  responsePayload: unknown,
): ApprovalRecord {
  const params = (message.params ?? {}) as Record<string, unknown>;
  const command = typeof params.command === "string"
    ? params.command
    : Array.isArray(params.command)
      ? params.command.join(" ")
      : null;

  return {
    method: message.method ?? "(unknown)",
    requestId: message.id ?? "(missing)",
    decision,
    command,
    cwd: typeof params.cwd === "string" ? params.cwd : null,
    reason: typeof params.reason === "string" ? params.reason : null,
    availableDecisions: params.availableDecisions,
    responsePayload,
  };
}

function resultFileTextFor(decision: Decision): string {
  return `approval-demo:${decision}`;
}

function buildPrompt(decision: Decision): string {
  const text = resultFileTextFor(decision);
  return [
    "Run exactly one local shell command to create or overwrite",
    `./${RESULT_FILE} in the current working directory with this exact single-line content:`,
    "",
    text,
    "",
    "Use command execution, not apply_patch and not a direct file editing helper.",
    "After the command finishes, reply with a one-sentence summary.",
  ].join("\n");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runScenario(decision: Decision, options: Options): Promise<ScenarioResult> {
  const runDir = join(RUNS_DIR, `${timestampForPath()}-${decision}`);
  const workspaceDir = join(runDir, "workspace");
  const logsDir = join(runDir, "logs");
  const jsonRpcLogPath = join(logsDir, "jsonrpc.jsonl");
  const summaryPath = join(runDir, "summary.json");
  const serverStderrPath = join(logsDir, "server.stderr.log");

  await mkdir(workspaceDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  await writeFile(
    join(workspaceDir, "README.md"),
    [
      "# Codex app-server approval demo workspace",
      "",
      "This folder is created by the manual approval demo.",
      "The agent should only touch files in this folder.",
      "",
    ].join("\n"),
    "utf8",
  );

  const rawLog = createWriteStream(jsonRpcLogPath, { flags: "a", encoding: "utf8" });
  const port = await pickFreePort();
  const proc = await startAppServer(port, serverStderrPath);
  let client: JsonRpcWsClient | null = null;

  const approvalRecords: ApprovalRecord[] = [];
  const turnDone = deferred<string>();
  let sawTurnDone = false;

  const scenarioStarted = Date.now();
  const scenarioTimeout = setTimeout(() => {
    turnDone.reject(new Error(`Scenario timed out after ${options.timeoutMs}ms`));
  }, options.timeoutMs);
  scenarioTimeout.unref?.();

  try {
    await waitForReady(port, Math.min(15_000, options.timeoutMs));
    client = await JsonRpcWsClient.connect(`ws://127.0.0.1:${port}`, rawLog);

    client.onServerRequest = async (message) => {
      if (!message.method || message.id === undefined) return;
      if (!isApprovalRequest(message.method)) {
        // A production adapter should implement more server requests. The demo
        // fails closed so unexpected prompts are visible in jsonrpc.jsonl.
        client?.respondError(message.id, -32601, `Demo does not handle ${message.method}`);
        return;
      }

      const responsePayload = approvalResponseFor(message.method, decision);
      approvalRecords.push(extractApprovalRecord(message, decision, responsePayload));
      console.error(`[approval-demo] ${message.method}: ${decision}`);
      client?.respond(message.id, responsePayload);
    };

    client.onNotification = (message) => {
      const method = message.method ?? "";
      if (method === "item/started") {
        const params = message.params as { item?: { type?: string; command?: string } } | undefined;
        if (params?.item?.type === "commandExecution") {
          console.error(`[approval-demo] command started: ${params.item.command ?? "(unknown)"}`);
        }
      }

      if (method === "item/completed") {
        const params = message.params as { item?: { type?: string; status?: string; exitCode?: number | null } } | undefined;
        if (params?.item?.type === "commandExecution") {
          console.error(
            `[approval-demo] command completed: status=${params.item.status} exit=${params.item.exitCode}`,
          );
        }
      }

      if (method === "turn/completed") {
        const params = message.params as { turn?: { status?: string } } | undefined;
        sawTurnDone = true;
        turnDone.resolve(params?.turn?.status ?? "completed");
      }

      if (method === "error") {
        turnDone.reject(new Error(`app-server error: ${JSON.stringify(message.params)}`));
      }
    };

    const initResult = await client.request(
      "initialize",
      {
        clientInfo: {
          name: "chatccc-codex-approval-demo",
          title: "ChatCCC Codex Approval Demo",
          version: "0.0.0-demo",
        },
        capabilities: {
          experimentalApi: true,
        },
      },
      20_000,
    );
    console.error(`[approval-demo] initialized: ${JSON.stringify(initResult)}`);

    const threadResult = await client.request(
      "thread/start",
      {
        cwd: resolve(workspaceDir),
        approvalPolicy: options.approvalPolicy,
        approvalsReviewer: "user",
        sandbox: options.sandbox,
        ephemeral: true,
        ...(options.model ? { model: options.model } : {}),
        serviceName: "chatccc-codex-approval-demo",
        developerInstructions: [
          "You are participating in a deterministic approval protocol demo.",
          "When the user asks you to create a file, use command execution.",
          "Do not use apply_patch or direct filesystem helper tools.",
        ].join("\n"),
      },
      30_000,
    ) as { thread?: { id?: string } };

    const threadId = threadResult.thread?.id;
    if (!threadId) throw new Error(`thread/start did not return a thread id: ${JSON.stringify(threadResult)}`);
    console.error(`[approval-demo] thread=${threadId}`);

    await client.request(
      "turn/start",
      {
        threadId,
        input: [
          {
            type: "text",
            text: buildPrompt(decision),
            text_elements: [],
          },
        ],
        approvalPolicy: options.approvalPolicy,
      },
      30_000,
    );
    console.error(`[approval-demo] turn started; waiting for approval and completion...`);

    const turnStatus = await turnDone.promise;
    clearTimeout(scenarioTimeout);

    const resultPath = join(workspaceDir, RESULT_FILE);
    const resultFileExists = await pathExists(resultPath);
    const resultFileText = resultFileExists ? (await readFile(resultPath, "utf8")).trim() : null;

    const result: ScenarioResult = {
      decision,
      runDir,
      workspaceDir,
      approvalCount: approvalRecords.length,
      approvalRecords,
      turnStatus,
      resultFileExists,
      resultFileText,
    };

    await writeFile(summaryPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

    if (approvalRecords.length === 0) {
      throw new Error(`No approval request was observed. Inspect ${jsonRpcLogPath}`);
    }

    if ((decision === "accept" || decision === "acceptForSession") && resultFileText !== resultFileTextFor(decision)) {
      throw new Error(
        `Expected ${RESULT_FILE} to contain ${resultFileTextFor(decision)}, got ${JSON.stringify(resultFileText)}`,
      );
    }

    if ((decision === "decline" || decision === "cancel") && resultFileExists) {
      throw new Error(`Expected no ${RESULT_FILE} for ${decision}, but it exists with ${JSON.stringify(resultFileText)}`);
    }

    if (!sawTurnDone) {
      throw new Error("Turn did not complete");
    }

    console.error(`[approval-demo] summary=${summaryPath}`);
    return result;
  } finally {
    clearTimeout(scenarioTimeout);
    client?.close();
    await killProcessTree(proc.pid);
    await closeStream(rawLog);
    if (options.cleanupWorkspace) {
      await rm(runDir, { recursive: true, force: true });
    }
    const elapsed = Date.now() - scenarioStarted;
    console.error(`[approval-demo] scenario ${decision} finished in ${elapsed}ms`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const decisions: Decision[] =
    options.decision === "matrix"
      ? ["accept", "acceptForSession", "decline", "cancel"]
      : [options.decision];

  console.error(`[approval-demo] decisions=${decisions.join(", ")}`);
  console.error(`[approval-demo] sandbox=${options.sandbox} approvalPolicy=${options.approvalPolicy}`);

  const results: ScenarioResult[] = [];
  for (const decision of decisions) {
    console.error(`\n[approval-demo] === ${decision} ===`);
    results.push(await runScenario(decision, options));
  }

  console.log(JSON.stringify({ ok: true, results }, null, 2));
}

main().catch((err) => {
  console.error("[approval-demo] failed:", err);
  process.exitCode = 1;
});
