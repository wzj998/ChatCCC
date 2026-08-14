import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";

export type EngineId = string;
export type EngineStepState = "pending" | "running" | "completed" | "failed";

export interface EngineStep {
  id: string;
  label: string;
  state: EngineStepState;
  percent: number;
  message: string;
  error?: string;
}

export interface EngineInstallJob {
  schemaVersion: 1;
  jobId: string;
  engineId: EngineId;
  targetVersion: string;
  state: "running" | "succeeded" | "failed";
  percent: number;
  startedAt: string;
  updatedAt: string;
  steps: EngineStep[];
  error?: string;
}

export interface EngineSpec {
  id: EngineId;
  label: string;
  version: string;
  packages: Readonly<Record<string, string>>;
  entryRelativePath: string;
  expectedBytes: number;
  minimumNodeVersion: string;
  prepareInstallation?: (installationDir: string) => Promise<void>;
  verifyRuntime?: (installationDir: string) => Promise<void>;
}

export interface EngineStatus {
  id: EngineId;
  label: string;
  installed: boolean;
  version: string | null;
  targetVersion: string;
  entryPath: string | null;
  running: boolean;
  job: EngineInstallJob | null;
}

type InstallPackages = (
  installationDir: string,
  spec: EngineSpec,
  onProgress: (percent: number, message: string) => Promise<void>,
) => Promise<void>;

export interface EngineManagerOptions {
  rootDir?: string;
  specs: readonly EngineSpec[];
  installPackages?: InstallPackages;
  verifyRuntime?: (installationDir: string, spec: EngineSpec) => Promise<void>;
  nodeVersion?: string;
}

const STEP_DEFINITIONS = [
  ["preflight", "检查运行环境"],
  ["prepare", "准备临时目录"],
  ["download_install", "下载并安装依赖"],
  ["verify_packages", "校验文件与版本"],
  ["runtime_handshake", "启动并验证 Runtime"],
  ["activate", "原子切换版本"],
  ["cleanup", "清理旧版本"],
] as const;

export const DEFAULT_ENGINE_ROOT = join(homedir(), ".chatccc", "engines");

export function createCoalescedAsyncTask(task: () => Promise<void>): {
  schedule(): void;
  flush(): Promise<void>;
} {
  let requested = false;
  let active: Promise<void> | null = null;
  let failed = false;
  let failure: unknown;

  const start = (): void => {
    if (active || failed) return;
    active = (async () => {
      while (requested) {
        requested = false;
        await task();
      }
    })().catch((error) => {
      failed = true;
      failure = error;
      requested = false;
    }).finally(() => {
      active = null;
      if (requested) start();
    });
  };

  return {
    schedule(): void {
      requested = true;
      start();
    },
    async flush(): Promise<void> {
      if (!failed) {
        requested = true;
        start();
      }
      while (active) await active;
      if (failed) throw failure;
    },
  };
}

async function renameWithTransientRetry(source: string, destination: string): Promise<void> {
  const retriable = new Set(["EPERM", "EBUSY", "EACCES"]);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!retriable.has(code) || attempt >= 5) throw error;
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20 * (2 ** attempt)));
    }
  }
}

export function resolveNpmInvocation(): { command: string; argsPrefix: string[] } {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((pathDir) =>
      join(pathDir, "node_modules", "npm", "bin", "npm-cli.js")),
  ];
  const npmCliPath = candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
  if (!npmCliPath) {
    throw new Error("找不到 npm-cli.js；请先安装 npm，并确保 npm 与当前 Node.js 位于同一环境。");
  }
  return { command: process.execPath, argsPrefix: [npmCliPath] };
}

export class EngineManager {
  private readonly rootDir: string;
  private readonly specs = new Map<string, EngineSpec>();
  private readonly installPackages: InstallPackages;
  private readonly verifyRuntime?: EngineManagerOptions["verifyRuntime"];
  private readonly nodeVersion: string;
  private readonly activeInstalls = new Map<string, Promise<EngineInstallJob>>();
  private readonly persistTails = new Map<string, Promise<void>>();

  constructor(options: EngineManagerOptions) {
    this.rootDir = options.rootDir ?? DEFAULT_ENGINE_ROOT;
    for (const spec of options.specs) this.specs.set(spec.id, spec);
    this.installPackages = options.installPackages ?? defaultInstallPackages;
    this.verifyRuntime = options.verifyRuntime;
    this.nodeVersion = options.nodeVersion ?? process.versions.node;
  }

  listSpecs(): EngineSpec[] {
    return [...this.specs.values()];
  }

  getSpec(engineId: string): EngineSpec {
    const spec = this.specs.get(engineId);
    if (!spec) throw new Error(`Unknown engine: ${engineId}`);
    return spec;
  }

  async getStatus(engineId: string): Promise<EngineStatus> {
    const spec = this.getSpec(engineId);
    const pointer = await this.readPointer(spec);
    const entryPath = pointer ? join(this.engineDir(spec), pointer.directory, spec.entryRelativePath) : null;
    const installed = Boolean(entryPath && existsSync(entryPath));
    return {
      id: spec.id,
      label: spec.label,
      installed,
      version: installed ? pointer?.version ?? null : null,
      targetVersion: spec.version,
      entryPath: installed ? entryPath : null,
      running: this.activeInstalls.has(engineId),
      job: await this.readJob(spec),
    };
  }

  async getEntryPath(engineId: string): Promise<string> {
    const status = await this.getStatus(engineId);
    if (!status.installed || !status.entryPath) {
      throw new Error(`${status.label} 尚未安装，请先在设置页安装引擎。`);
    }
    return status.entryPath;
  }

  async startInstall(engineId: string): Promise<EngineInstallJob> {
    const running = this.activeInstalls.get(engineId);
    if (running) return this.readJob(this.getSpec(engineId)).then((job) => job ?? this.newJob(this.getSpec(engineId)));

    const spec = this.getSpec(engineId);
    const job = this.newJob(spec);
    await this.persistJob(spec, job);
    const task = this.runInstall(spec, job).finally(() => this.activeInstalls.delete(engineId));
    this.activeInstalls.set(engineId, task);
    return cloneJob(job);
  }

  async install(engineId: string): Promise<EngineInstallJob> {
    await this.startInstall(engineId);
    return this.waitForInstall(engineId);
  }

  async waitForInstall(engineId: string): Promise<EngineInstallJob> {
    const active = this.activeInstalls.get(engineId);
    if (active) return active;
    const job = await this.readJob(this.getSpec(engineId));
    if (!job) throw new Error(`No install job for engine: ${engineId}`);
    return job;
  }

  private newJob(spec: EngineSpec): EngineInstallJob {
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      jobId: randomUUID(),
      engineId: spec.id,
      targetVersion: spec.version,
      state: "running",
      percent: 0,
      startedAt: now,
      updatedAt: now,
      steps: STEP_DEFINITIONS.map(([id, label]) => ({ id, label, state: "pending", percent: 0, message: "等待中" })),
    };
  }

  private async runInstall(spec: EngineSpec, job: EngineInstallJob): Promise<EngineInstallJob> {
    const stagingDir = join(this.rootDir, ".staging", `${spec.id}-${job.jobId}`);
    let publishedDir: string | null = null;
    try {
      await this.runStep(spec, job, "preflight", async (update) => {
        await update(20, `Node.js ${this.nodeVersion}`);
        if (compareVersions(this.nodeVersion, spec.minimumNodeVersion) < 0) {
          throw new Error(`${spec.label} 要求 Node.js >= ${spec.minimumNodeVersion}，当前为 ${this.nodeVersion}`);
        }
        await mkdir(this.rootDir, { recursive: true });
        await update(100, "运行环境可用");
      });

      await this.runStep(spec, job, "prepare", async (update) => {
        await rm(stagingDir, { recursive: true, force: true });
        await mkdir(stagingDir, { recursive: true });
        await writeFile(join(stagingDir, "package.json"), JSON.stringify({
          name: `chatccc-engine-${spec.id}`,
          private: true,
          type: "module",
          dependencies: spec.packages,
        }, null, 2) + "\n", "utf8");
        await spec.prepareInstallation?.(stagingDir);
        await update(100, "临时安装目录已准备");
      });

      await this.runStep(spec, job, "download_install", async (update) => {
        await this.installPackages(stagingDir, spec, update);
        await update(100, "依赖安装完成");
      });

      await this.runStep(spec, job, "verify_packages", async (update) => {
        const entries = Object.entries(spec.packages);
        for (let index = 0; index < entries.length; index += 1) {
          const [packageName, expectedVersion] = entries[index];
          const packageJson = join(stagingDir, "node_modules", ...packageName.split("/"), "package.json");
          const parsed = JSON.parse(await readFile(packageJson, "utf8")) as { version?: unknown };
          if (parsed.version !== expectedVersion) {
            throw new Error(`${packageName} 版本校验失败：期望 ${expectedVersion}，实际 ${String(parsed.version)}`);
          }
          await update(Math.round(((index + 1) / entries.length) * 90), `已校验 ${packageName}`);
        }
        const entry = join(stagingDir, spec.entryRelativePath);
        if (!existsSync(entry)) throw new Error(`引擎入口不存在：${entry}`);
        await update(100, "文件和版本校验通过");
      });

      await this.runStep(spec, job, "runtime_handshake", async (update) => {
        await update(10, "正在启动 Runtime");
        if (this.verifyRuntime) await this.verifyRuntime(stagingDir, spec);
        else await spec.verifyRuntime?.(stagingDir);
        await update(100, "Runtime 握手成功");
      });

      await this.runStep(spec, job, "activate", async (update) => {
        const directoryName = `${spec.version}-${job.jobId}`;
        const versionsDir = join(this.engineDir(spec), "versions");
        publishedDir = join(versionsDir, directoryName);
        await mkdir(versionsDir, { recursive: true });
        await rename(stagingDir, publishedDir);
        const pointer = {
          schemaVersion: 1,
          version: spec.version,
          directory: relative(this.engineDir(spec), publishedDir).replaceAll("\\", "/"),
          activatedAt: new Date().toISOString(),
        };
        const pointerPath = join(this.engineDir(spec), "current.json");
        const temporaryPointer = `${pointerPath}.${job.jobId}.tmp`;
        await writeFile(temporaryPointer, JSON.stringify(pointer, null, 2) + "\n", "utf8");
        await renameWithTransientRetry(temporaryPointer, pointerPath);
        await update(100, `已切换到 v${spec.version}`);
      });

      await this.runStep(spec, job, "cleanup", async (update) => {
        const versionsDir = join(this.engineDir(spec), "versions");
        const keep = publishedDir ? resolve(publishedDir) : "";
        const entries = await readdir(versionsDir, { withFileTypes: true });
        const old = entries.filter((entry) => entry.isDirectory() && resolve(versionsDir, entry.name) !== keep);
        for (let index = 0; index < old.length; index += 1) {
          await rm(join(versionsDir, old[index].name), { recursive: true, force: true });
          await update(Math.round(((index + 1) / Math.max(old.length, 1)) * 100), `已清理 ${old[index].name}`);
        }
        await update(100, old.length ? "旧版本已清理" : "无需清理旧版本");
      });

      job.state = "succeeded";
      job.percent = 100;
      job.updatedAt = new Date().toISOString();
      await this.persistJob(spec, job);
      return cloneJob(job);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      job.state = "failed";
      job.error = message.slice(0, 1000);
      job.updatedAt = new Date().toISOString();
      await this.persistJob(spec, job);
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      return cloneJob(job);
    }
  }

  private async runStep(
    spec: EngineSpec,
    job: EngineInstallJob,
    stepId: string,
    operation: (update: (percent: number, message: string) => Promise<void>) => Promise<void>,
  ): Promise<void> {
    const step = job.steps.find((candidate) => candidate.id === stepId)!;
    step.state = "running";
    step.message = "进行中";
    await this.recalculateAndPersist(spec, job);
    const update = async (percent: number, message: string): Promise<void> => {
      step.percent = Math.max(0, Math.min(100, Math.round(percent)));
      step.message = message;
      await this.recalculateAndPersist(spec, job);
    };
    try {
      await operation(update);
      step.state = "completed";
      step.percent = 100;
      await this.recalculateAndPersist(spec, job);
    } catch (error) {
      step.state = "failed";
      step.error = error instanceof Error ? error.message : String(error);
      step.message = "失败";
      await this.recalculateAndPersist(spec, job);
      throw error;
    }
  }

  private async recalculateAndPersist(spec: EngineSpec, job: EngineInstallJob): Promise<void> {
    job.percent = Math.round(job.steps.reduce((sum, step) => sum + step.percent, 0) / job.steps.length);
    job.updatedAt = new Date().toISOString();
    await this.persistJob(spec, job);
  }

  private engineDir(spec: EngineSpec): string {
    return join(this.rootDir, spec.id);
  }

  private jobPath(spec: EngineSpec): string {
    return join(this.rootDir, "engine-jobs", `${spec.id}.json`);
  }

  private async persistJob(spec: EngineSpec, job: EngineInstallJob): Promise<void> {
    const path = this.jobPath(spec);
    const contents = JSON.stringify(job, null, 2) + "\n";
    const previous = this.persistTails.get(spec.id) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, contents, "utf8");
        await renameWithTransientRetry(temporary, path);
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
    });
    this.persistTails.set(spec.id, operation);
    try {
      await operation;
    } finally {
      if (this.persistTails.get(spec.id) === operation) this.persistTails.delete(spec.id);
    }
  }

  private async readJob(spec: EngineSpec): Promise<EngineInstallJob | null> {
    try {
      const parsed = JSON.parse(await readFile(this.jobPath(spec), "utf8")) as EngineInstallJob;
      if (parsed.state === "running" && !this.activeInstalls.has(spec.id)) {
        parsed.state = "failed";
        parsed.error = "上一次安装任务因进程退出而中断，请重试。";
        const running = parsed.steps.find((step) => step.state === "running");
        if (running) {
          running.state = "failed";
          running.message = "安装任务已中断";
          running.error = parsed.error;
        }
        parsed.updatedAt = new Date().toISOString();
        await this.persistJob(spec, parsed);
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private async readPointer(spec: EngineSpec): Promise<{ version: string; directory: string } | null> {
    try {
      const parsed = JSON.parse(await readFile(join(this.engineDir(spec), "current.json"), "utf8")) as {
        version?: unknown;
        directory?: unknown;
      };
      if (typeof parsed.version !== "string" || typeof parsed.directory !== "string") return null;
      const resolved = resolve(this.engineDir(spec), parsed.directory);
      const versionsDir = resolve(this.engineDir(spec), "versions");
      if (resolved !== versionsDir && !resolved.startsWith(`${versionsDir}\\`) && !resolved.startsWith(`${versionsDir}/`)) return null;
      return { version: parsed.version, directory: parsed.directory };
    } catch {
      return null;
    }
  }
}

async function defaultInstallPackages(
  installationDir: string,
  spec: EngineSpec,
  onProgress: (percent: number, message: string) => Promise<void>,
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    let npmInvocation: ReturnType<typeof resolveNpmInvocation>;
    try {
      npmInvocation = resolveNpmInvocation();
    } catch (error) {
      reject(error);
      return;
    }
    const child = spawn(npmInvocation.command, [...npmInvocation.argsPrefix, "install", "--prefix", installationDir, "--no-audit", "--no-fund", "--save-exact", "--loglevel=http"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    let requests = 0;
    const progressReporter = createCoalescedAsyncTask(async () => {
        const bytes = await directorySize(installationDir);
        const sizePercent = spec.expectedBytes > 0 ? Math.min(92, (bytes / spec.expectedBytes) * 92) : 0;
        const requestPercent = Math.min(85, requests * 2);
        const percent = Math.max(3, sizePercent, requestPercent);
        await onProgress(percent, `已下载/写入 ${(bytes / 1048576).toFixed(1)} MB`);
    });
    const report = (): void => progressReporter.schedule();
    child.stdout.on("data", (chunk: Buffer) => {
      requests += (chunk.toString().match(/http fetch GET|GET \d{3}/g) ?? []).length;
      report();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr = (stderr + text).slice(-4000);
      requests += (text.match(/http fetch GET|GET \d{3}/g) ?? []).length;
      report();
    });
    const timer = setInterval(report, 1000);
    timer.unref?.();
    child.once("error", (error) => {
      clearInterval(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearInterval(timer);
      void progressReporter.flush().then(() => {
        if (code === 0) resolvePromise();
        else reject(new Error(`npm install 失败（退出码 ${String(code)}）：${stderr.trim().split(/\r?\n/).slice(-6).join(" | ").slice(0, 1000)}`));
      }).catch(reject);
    });
  });
}

async function directorySize(root: string): Promise<number> {
  let total = 0;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop()!;
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        try { total += (await stat(path)).size; } catch { /* file changed during scan */ }
      }
    }
  }
  return total;
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0) ? 1 : -1;
  }
  return 0;
}

function cloneJob(job: EngineInstallJob): EngineInstallJob {
  return JSON.parse(JSON.stringify(job)) as EngineInstallJob;
}
