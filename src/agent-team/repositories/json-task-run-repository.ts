import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  isActiveTaskRun,
  parseTaskRun,
  type TaskRun,
  type TaskRunRepository,
} from "../domain/task-run.ts";

export interface JsonTaskRunRepositoryOptions {
  rootDir?: string;
}

export class JsonTaskRunRepository implements TaskRunRepository {
  readonly rootDir: string;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: JsonTaskRunRepositoryOptions = {}) {
    this.rootDir = options.rootDir ?? join(homedir(), ".chatccc", "agent-team", "task-runs");
  }

  async get(runId: string): Promise<TaskRun | null> {
    const files = await this.projectDirectories();
    for (const projectId of files) {
      try {
        return parseTaskRun(JSON.parse(await readFile(this.pathFor(projectId, runId), "utf8")));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    return null;
  }

  async save(run: TaskRun): Promise<void> {
    const parsed = parseTaskRun(run);
    await this.exclusive(async () => {
      await writeJsonAtomic(this.pathFor(parsed.projectId, parsed.runId), parsed);
    });
  }

  async listByProject(projectId: string): Promise<TaskRun[]> {
    const directory = this.projectPath(projectId);
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const runs = await Promise.all(entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) => parseTaskRun(JSON.parse(await readFile(join(directory, entry), "utf8")))));
    return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.runId.localeCompare(a.runId));
  }

  async listActive(): Promise<TaskRun[]> {
    const projectIds = await this.projectDirectories();
    const runs = (await Promise.all(projectIds.map((projectId) => this.listByProject(projectId)))).flat();
    return runs.filter(isActiveTaskRun);
  }

  private async projectDirectories(): Promise<string[]> {
    try {
      return await readdir(this.rootDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  private projectPath(projectId: string): string {
    assertId(projectId, "project");
    return join(this.rootDir, projectId);
  }

  private pathFor(projectId: string, runId: string): string {
    assertId(runId, "run");
    return join(this.projectPath(projectId), `${runId}.json`);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release!: () => void;
    this.operationQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function assertId(value: string, kind: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error(`Invalid ${kind} id: ${value}`);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await rename(tempPath, path);
  } catch (err) {
    await unlink(tempPath).catch(() => {});
    throw err;
  }
}
