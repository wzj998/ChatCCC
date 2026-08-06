import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testHome = vi.hoisted(() => ({ dir: "" }));

const aiMocks = vi.hoisted(() => ({
  streamText: vi.fn(),
  generateText: vi.fn(),
}));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  const [{ mkdtempSync }, { join }] = await Promise.all([import("node:fs"), import("node:path")]);
  testHome.dir = mkdtempSync(join(actual.tmpdir(), "chatccc-builtin-perm-"));
  return { ...actual, homedir: () => testHome.dir };
});

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn(() => (modelId: string) => ({ modelId })),
}));

vi.mock("ai", () => ({
  streamText: aiMocks.streamText,
  generateText: aiMocks.generateText,
  isLoopFinished: vi.fn(() => ({ loopFinished: true })),
  stepCountIs: vi.fn((count: number) => ({ count })),
  jsonSchema: vi.fn((schema: unknown) => schema),
  tool: vi.fn((definition: unknown) => definition),
}));

vi.mock("../raw-stream-log.js", () => ({
  createRawStreamLog: vi.fn().mockResolvedValue(null),
}));

import {
  PermissionGate,
  getAllowRules,
  isDangerousCommand,
  matchRule,
  reloadAllowRules,
} from "../permissions.js";
import { createBuiltinFileTools } from "../file-tools.js";
import { ChatSession } from "../index.js";

const streamTextMock = aiMocks.streamText;
const generateTextMock = aiMocks.generateText;

const ALLOW_FILE = () => join(testHome.dir, ".deepccc", "allow.json");

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

async function* textStream(...chunks: string[]): AsyncIterable<string> {
  for (const chunk of chunks) yield chunk;
}

function lastRunCommandExecute(): (input: { command: string }, opts?: unknown) => Promise<unknown> {
  const call = streamTextMock.mock.calls.at(-1)?.[0] as { tools?: Record<string, { execute?: unknown }> };
  const execute = call?.tools?.run_command?.execute as ((input: { command: string }, opts?: unknown) => Promise<unknown>) | undefined;
  if (!execute) throw new Error("streamText was not called with tools.run_command.execute");
  return execute;
}

afterEach(() => {
  try {
    rmSync(ALLOW_FILE(), { force: true });
  } catch {}
  reloadAllowRules();
  streamTextMock.mockReset();
  generateTextMock.mockReset();
});

beforeEach(() => {
  try {
    rmSync(join(testHome.dir, ".deepccc"), { recursive: true, force: true });
  } catch {}
  mkdirSync(join(testHome.dir, ".deepccc"), { recursive: true });
  reloadAllowRules();
});

describe("builtin permissions module", () => {
  it("flags destructive commands and ignores normal ones", () => {
    expect(isDangerousCommand("rm -rf node_modules")).toBe(true);
    expect(isDangerousCommand("git push --force origin main")).toBe(true);
    expect(isDangerousCommand("git status")).toBe(false);
    expect(isDangerousCommand("npm test")).toBe(false);
  });

  it("matches allow/deny rules with wildcards and relative paths", () => {
    expect(matchRule("run_command:git status*", "run_command:git status --short")).toBe(true);
    expect(matchRule("edit_file:node_modules/**", "edit_file:node_modules/a/b.js")).toBe(true);
    expect(matchRule("run_command:npm test", "run_command:npm test extra")).toBe(false);
  });

  it("returns empty rules when allow.json is missing", () => {
    expect(getAllowRules()).toEqual({ allow: [], deny: [] });
  });

  it("loads rules from ~/.deepccc/allow.json", () => {
    writeFileSync(ALLOW_FILE(), JSON.stringify({ deny: ["run_command:npm publish*"] }), "utf-8");
    reloadAllowRules();
    expect(getAllowRules().deny).toEqual(["run_command:npm publish*"]);
  });
});

describe("builtin PermissionGate", () => {
  it("bypass mode allows everything", async () => {
    const gate = new PermissionGate("bypass");
    expect(await gate.check({ tool: "run_command", action: "rm -rf /", reason: "high-risk", detail: "x" })).toBe("allow");
  });

  it("ask mode denies high-risk without resolver", async () => {
    const gate = new PermissionGate("ask");
    expect(await gate.check({ tool: "run_command", action: "rm -rf x", reason: "high-risk", detail: "x" })).toBe("deny");
  });

  it("ask mode allows non-high-risk operations without asking", async () => {
    const resolver = vi.fn();
    const gate = new PermissionGate("ask", resolver as never);
    expect(await gate.check({ tool: "run_command", action: "npm test", reason: "rule", detail: "x" })).toBe("allow");
    expect(await gate.check({ tool: "edit_file", action: "src/a.ts", reason: "rule", detail: "x" })).toBe("allow");
    expect(resolver).not.toHaveBeenCalled();
  });

  it("follows resolver answer", async () => {
    let answer: "allow" | "deny" = "allow";
    const gate = new PermissionGate("ask", async () => answer);
    expect(await gate.check({ tool: "run_command", action: "rm -rf x", reason: "high-risk", detail: "x" })).toBe("allow");
    answer = "deny";
    expect(await gate.check({ tool: "run_command", action: "rm -rf x", reason: "high-risk", detail: "x" })).toBe("deny");
  });

  it("deny rule wins over allow rule", async () => {
    writeFileSync(
      ALLOW_FILE(),
      JSON.stringify({ allow: ["run_command:rm -rf /tmp*"], deny: ["run_command:rm -rf /tmp/forbidden*"] }),
      "utf-8",
    );
    reloadAllowRules();
    const gate = new PermissionGate("ask");
    expect(await gate.check({ tool: "run_command", action: "rm -rf /tmp/forbidden/x", reason: "high-risk", detail: "x" })).toBe("deny");
  });
});

describe("builtin file-tools permission integration", () => {
  it("run_command high-risk is denied by default gate", async () => {
    const tools = createBuiltinFileTools(testHome.dir, { permissionGate: new PermissionGate("ask") });
    const tool = tools.run_command as unknown as {
      execute: (input: { command: string }, opts?: unknown) => Promise<unknown>;
    };
    await expect(tool.execute({ command: "rm -rf node_modules" }, { abortSignal: undefined })).rejects.toThrow(/权限拒绝/);
  });

  it("no gate keeps original behavior", async () => {
    const tools = createBuiltinFileTools(testHome.dir);
    const tool = tools.run_command as unknown as {
      execute: (input: { command: string }, opts?: unknown) => Promise<{ exitCode: number | null }>;
    };
    const result = await tool.execute({ command: "node -e \"console.log('ok')\"" }, { abortSignal: undefined });
    expect(result.exitCode).toBe(0);
  });
});

describe("builtin ChatSession permission integration", () => {
  it("permissionMode bypass lets high-risk run_command execute", async () => {
    const session = new ChatSession(
      { apiKey: "sk-test" },
      { sessionId: "perm-bypass", permissionMode: "bypass" },
    );
    streamTextMock.mockReturnValueOnce({ textStream: textStream("hi") });
    await collect(session.chat("hi"));

    const result = (await lastRunCommandExecute()({ command: "node -e \"console.log('ok')\"" }, { abortSignal: undefined })) as { exitCode: number };
    expect(result.exitCode).toBe(0);
  });

  it("default ask mode without resolver denies high-risk run_command", async () => {
    const session = new ChatSession(
      { apiKey: "sk-test" },
      { sessionId: "perm-ask" },
    );
    streamTextMock.mockReturnValueOnce({ textStream: textStream("hi") });
    await collect(session.chat("hi"));

    await expect(
      lastRunCommandExecute()({ command: "rm -rf node_modules" }, { abortSignal: undefined }),
    ).rejects.toThrow(/权限拒绝/);
  });
});
