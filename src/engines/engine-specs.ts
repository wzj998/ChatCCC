import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { type EngineSpec, EngineManager } from "./engine-manager.ts";

export const CLAUDE_ENGINE_VERSION = "0.2.133";
export const DSH_ENGINE_VERSION = "0.1.0-rc.6";

const DSH_PACKAGES: Readonly<Record<string, string>> = {
  "@deepseek-ai/dsh": DSH_ENGINE_VERSION,
  "@deepseek-ai/dsh-sdk-client": DSH_ENGINE_VERSION,
  "@deepseek-ai/dsh-sdk-jsonrpc-demo": DSH_ENGINE_VERSION,
  "@deepseek-ai/dsh-sdk-jsonrpc-server": DSH_ENGINE_VERSION,
  "@deepseek-ai/dsh-agent-spine-demo": DSH_ENGINE_VERSION,
  "@deepseek-ai/dsh-llm-deepseek": DSH_ENGINE_VERSION,
  "@deepseek-ai/dsh-session-persistence-jsonl": DSH_ENGINE_VERSION,
  "@deepseek-ai/dsh-session-checkpoint-policy": DSH_ENGINE_VERSION,
  "@deepseek-ai/dsh-subprocess-local": DSH_ENGINE_VERSION,
  "@deepseek-ai/dsh-bash-local": DSH_ENGINE_VERSION,
  "@deepseek-ai/dsh-fs-local": DSH_ENGINE_VERSION,
  "@deepseek-ai/dsh-subagent": DSH_ENGINE_VERSION,
  "@deepseek-ai/dsh-subagent-spawn-in-process": DSH_ENGINE_VERSION,
  "@deepseek-ai/dsh-tool-subagent": DSH_ENGINE_VERSION,
  "@deepseek-ai/dsh-tool-todo": DSH_ENGINE_VERSION,
  "@deepseek-ai/dsh-fs-observation-policy": DSH_ENGINE_VERSION,
  "@deepseek-ai/dsh-tool-fs": DSH_ENGINE_VERSION,
  "@deepseek-ai/dsh-token-meter": DSH_ENGINE_VERSION,
  "@deepseek-ai/dsh-compaction-basic": DSH_ENGINE_VERSION,
};

export const DSH_RUNTIME_CONFIG = `# Generated and owned by ChatCCC. Secrets are supplied through the child environment.
- id: sdk-jsonrpc-server
  name: '@deepseek-ai/dsh-sdk-jsonrpc-server'
  config:
    maxTokensAsSuccess: true
- id: agent-core
  name: '@deepseek-ai/dsh-agent-spine-demo'
  config:
    persona: !!js process.env.DSH_SYSTEM_PROMPT ?? 'You are a coding agent.'
    workspaceContext: false
    skills:
      enabled: false
    toolBash:
      enableRunInBackground: false
    toolJobs: false
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    thinking: enabled
    reasoningEffort: max
- id: sessions
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: !!js process.env.DSH_SESSION_ROOT
    compression: zstd
- id: session-checkpoints
  name: '@deepseek-ai/dsh-session-checkpoint-policy'
- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'
- id: bash
  name: '@deepseek-ai/dsh-bash-local'
  config:
    cwd: !!js process.env.DSH_CWD
    timeoutMs: 60000
- id: fs-local
  name: '@deepseek-ai/dsh-fs-local'
  config:
    cwd: !!js process.env.DSH_CWD
- id: subagent
  name: '@deepseek-ai/dsh-subagent'
- id: subagent-spawn-in-process
  name: '@deepseek-ai/dsh-subagent-spawn-in-process'
  config:
    providerName: spawn
- id: tool-subagent
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent
    enableRunInBackground: false
    agentOptions:
      provider: !!js process.env.DSH_SUBAGENT_PROVIDER ?? 'deepseek-official'
      model: !!js process.env.DSH_SUBAGENT_MODEL ?? 'deepseek-v4-flash'
      maxTokens: !!js Number(process.env.DSH_SUBAGENT_MAX_TOKENS ?? '49152')
- id: tool-todo
  name: '@deepseek-ai/dsh-tool-todo'
  config:
    allowParallelInProgress: true
- id: fs-observation-policy
  name: '@deepseek-ai/dsh-fs-observation-policy'
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
- id: token-meter
  name: '@deepseek-ai/dsh-token-meter'
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  config:
    thresholdRatio: 0.8
    retainRatio: 0.16
    maxTokens: 8192
    compactionRetries: 1
`;

export const ENGINE_SPECS: readonly EngineSpec[] = [
  {
    id: "claude",
    label: "Claude Code",
    version: CLAUDE_ENGINE_VERSION,
    packages: { "@anthropic-ai/claude-agent-sdk": CLAUDE_ENGINE_VERSION },
    entryRelativePath: join("node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs"),
    expectedBytes: 240 * 1024 * 1024,
    minimumNodeVersion: "20.0.0",
    verifyRuntime: async (dir) => {
      await import(pathToFileURL(join(dir, "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs")).href);
    },
  },
  {
    id: "dsh",
    label: "DeepSeek Harness",
    version: DSH_ENGINE_VERSION,
    packages: DSH_PACKAGES,
    entryRelativePath: join("node_modules", "@deepseek-ai", "dsh-sdk-client", "lib", "index.js"),
    expectedBytes: 265 * 1024 * 1024,
    minimumNodeVersion: "22.19.0",
    prepareInstallation: async (dir) => {
      await writeFile(join(dir, "dsh-runtime.cordis.yml"), DSH_RUNTIME_CONFIG, "utf8");
      await mkdir(join(dir, "sessions"), { recursive: true });
    },
    verifyRuntime: async (dir) => {
      const modulePath = join(dir, "node_modules", "@deepseek-ai", "dsh-sdk-client", "lib", "index.js");
      const sdk = await import(pathToFileURL(modulePath).href) as {
        DeepSeekHarness: new (options: unknown) => { start(): Promise<void>; close(): Promise<void> };
      };
      const runtime = new sdk.DeepSeekHarness({
        launch: {
          command: process.execPath,
          args: [join(dir, "node_modules", "@deepseek-ai", "dsh-sdk-jsonrpc-demo", "lib", "bin.js"), join(dir, "dsh-runtime.cordis.yml")],
          cwd: dir,
          env: {
            ...process.env,
            DSH_CWD: dir,
            DSH_SESSION_ROOT: join(dir, "sessions"),
          },
          requestTimeoutMs: 30_000,
        },
        cwd: dir,
        provider: "deepseek-official",
        model: "deepseek-v4-flash",
      });
      try {
        await runtime.start();
      } finally {
        await runtime.close();
      }
    },
  },
];

export const engineManager = new EngineManager({ specs: ENGINE_SPECS });
