import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  DEFAULT_BUILTIN_CONTEXT_DIR,
  getBuiltinContextSession,
  normalizeBuiltinSessionId,
} from "./context.js";

export interface WebSessionMeta {
  schemaVersion: 1;
  sessionId: string;
  title: string;
  cwd: string;
  model: string;
  subModel: string;
  effort: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWebSessionInput {
  cwd: string;
  title?: string;
  model?: string;
  subModel?: string;
  effort?: string;
}

export interface UpdateWebSessionInput {
  title?: string;
  model?: string;
  subModel?: string;
  effort?: string;
}

export interface WebSessionStoreOptions {
  rootDir?: string;
  now?: () => Date;
  idFactory?: () => string;
}

export class WebSessionStore {
  readonly rootDir: string;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(options: WebSessionStoreOptions = {}) {
    this.rootDir = options.rootDir ?? DEFAULT_BUILTIN_CONTEXT_DIR;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => `web-${randomUUID()}`);
  }

  async create(input: CreateWebSessionInput): Promise<WebSessionMeta> {
    const cwd = cleanCwd(input.cwd);
    const timestamp = this.now().toISOString();
    const sessionId = normalizeBuiltinSessionId(this.idFactory());
    const meta: WebSessionMeta = {
      schemaVersion: 1,
      sessionId,
      title: cleanTitle(input.title) || basename(cwd) || "新会话",
      cwd,
      model: input.model?.trim() ?? "",
      subModel: input.subModel?.trim() ?? "",
      effort: input.effort?.trim() ?? "",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.save(meta);
    return meta;
  }

  async get(sessionId: string): Promise<WebSessionMeta | null> {
    const normalized = normalizeBuiltinSessionId(sessionId);
    try {
      return parseMeta(JSON.parse(await readFile(this.metaPath(normalized), "utf8")));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        const context = getBuiltinContextSession(normalized, this.rootDir);
        if (!context) return null;
        const cwd = context.cwd ?? process.cwd();
        return {
          schemaVersion: 1,
          sessionId: normalized,
          title: basename(cwd) || normalized,
          cwd,
          model: "",
          subModel: "",
          effort: "",
          createdAt: new Date(context.createdAt).toISOString(),
          updatedAt: new Date(context.updatedAt).toISOString(),
        };
      }
      return null;
    }
  }

  async list(): Promise<WebSessionMeta[]> {
    let entries: string[];
    try {
      entries = await readdir(this.rootDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const sessions = await Promise.all(entries.map((entry) => this.get(entry)));
    return sessions
      .filter((session): session is WebSessionMeta => session !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.sessionId.localeCompare(b.sessionId));
  }

  async update(sessionId: string, patch: UpdateWebSessionInput): Promise<WebSessionMeta> {
    const current = await this.require(sessionId);
    const updated: WebSessionMeta = {
      ...current,
      ...(patch.title !== undefined ? { title: cleanTitle(patch.title) || current.title } : {}),
      ...(patch.model !== undefined ? { model: patch.model.trim() } : {}),
      ...(patch.subModel !== undefined ? { subModel: patch.subModel.trim() } : {}),
      ...(patch.effort !== undefined ? { effort: patch.effort.trim() } : {}),
      updatedAt: this.now().toISOString(),
    };
    await this.save(updated);
    return updated;
  }

  async delete(sessionId: string): Promise<boolean> {
    const normalized = normalizeBuiltinSessionId(sessionId);
    if (!await this.get(normalized)) return false;
    await rm(join(this.rootDir, normalized), { recursive: true, force: true });
    return true;
  }

  private async require(sessionId: string): Promise<WebSessionMeta> {
    const meta = await this.get(sessionId);
    if (!meta) throw new Error(`DeepCCC web session not found: ${sessionId}`);
    return meta;
  }

  private async save(meta: WebSessionMeta): Promise<void> {
    const path = this.metaPath(meta.sessionId);
    await mkdir(join(this.rootDir, meta.sessionId), { recursive: true });
    const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  }

  private metaPath(sessionId: string): string {
    const normalized = normalizeBuiltinSessionId(sessionId);
    return join(this.rootDir, normalized, "web.json");
  }
}

function cleanCwd(value: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("cwd must be a non-empty path");
  return resolve(value.trim());
}

function cleanTitle(value: string | undefined): string {
  return value?.trim().slice(0, 120) ?? "";
}

function parseMeta(value: unknown): WebSessionMeta {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid web session metadata");
  const meta = value as Partial<WebSessionMeta>;
  if (meta.schemaVersion !== 1) throw new Error("Unsupported web session metadata");
  for (const field of ["sessionId", "title", "cwd", "model", "subModel", "effort", "createdAt", "updatedAt"] as const) {
    if (typeof meta[field] !== "string") throw new Error(`Invalid web session ${field}`);
  }
  return meta as WebSessionMeta;
}
