import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { isAgentTool, type AgentTool } from "../../agent-tool.ts";

export type MainAgentBindingStatus = "provisioning" | "ready" | "error";

export interface MainAgentBinding {
  schemaVersion: 1;
  projectId: string;
  platform: "feishu";
  chatId?: string;
  sessionId?: string;
  agentId: AgentTool;
  namingPolicy: "project-fixed";
  status: MainAgentBindingStatus;
  ownerOpenId: string;
  lastError?: string;
  updatedAt: string;
}

export interface JsonMainAgentBindingRepositoryOptions {
  rootDir?: string;
}

export class JsonMainAgentBindingRepository {
  readonly rootDir: string;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: JsonMainAgentBindingRepositoryOptions = {}) {
    this.rootDir = options.rootDir ?? join(homedir(), ".chatccc", "agent-team", "main-agent-bindings");
  }

  async get(projectId: string): Promise<MainAgentBinding | null> {
    try {
      return parseBinding(JSON.parse(await readFile(this.pathFor(projectId), "utf8")));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async save(binding: MainAgentBinding): Promise<void> {
    const parsed = parseBinding(binding);
    await this.exclusive(async () => {
      await mkdir(this.rootDir, { recursive: true });
      const path = this.pathFor(parsed.projectId);
      const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
      try {
        await rename(tempPath, path);
      } catch (err) {
        await unlink(tempPath).catch(() => {});
        throw err;
      }
    });
  }

  private pathFor(projectId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) throw new Error(`Invalid project id: ${projectId}`);
    return join(this.rootDir, `${projectId}.json`);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release!: () => void;
    this.operationQueue = new Promise<void>((resolveQueue) => { release = resolveQueue; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function parseBinding(value: unknown): MainAgentBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid main Agent binding");
  const binding = value as Partial<MainAgentBinding>;
  if (binding.schemaVersion !== 1) throw new Error("Unsupported main Agent binding schema");
  if (typeof binding.projectId !== "string" || !binding.projectId) throw new Error("Main Agent binding is missing projectId");
  if (binding.platform !== "feishu") throw new Error("Unsupported main Agent platform");
  if (!isAgentTool(binding.agentId)) throw new Error("Unsupported main Agent tool");
  if (binding.namingPolicy !== "project-fixed") throw new Error("Unsupported main Agent naming policy");
  if (!(["provisioning", "ready", "error"] as const).includes(binding.status as MainAgentBindingStatus)) {
    throw new Error("Unsupported main Agent binding status");
  }
  if (typeof binding.ownerOpenId !== "string" || !binding.ownerOpenId) throw new Error("Main Agent binding is missing ownerOpenId");
  if (typeof binding.updatedAt !== "string" || !binding.updatedAt) throw new Error("Main Agent binding is missing updatedAt");
  if (binding.chatId !== undefined && typeof binding.chatId !== "string") throw new Error("Invalid main Agent chatId");
  if (binding.sessionId !== undefined && typeof binding.sessionId !== "string") throw new Error("Invalid main Agent sessionId");
  if (binding.lastError !== undefined && typeof binding.lastError !== "string") throw new Error("Invalid main Agent lastError");
  return binding as MainAgentBinding;
}
