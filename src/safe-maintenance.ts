import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { USER_DATA_DIR } from "./config.ts";

export type SafeMaintenanceKind = "restart" | "update";
export type SafeMaintenancePhase = "draining" | "executing" | "completed" | "failed";

export interface SafeMaintenanceRequester {
  platform: string;
  chatId: string;
  openId: string;
}

export interface SafeMaintenanceJob {
  schemaVersion: 1;
  jobId: string;
  kind: SafeMaintenanceKind;
  phase: SafeMaintenancePhase;
  requestedAt: string;
  updatedAt: string;
  requesters: SafeMaintenanceRequester[];
  lastError?: string;
}

export interface SafeMaintenanceSnapshot {
  activeSessionIds: string[];
  queuedSessionIds: string[];
  activeEngineIds: string[];
  activeWorkLabels: string[];
}

export interface SafeMaintenanceStatus {
  job: SafeMaintenanceJob | null;
  snapshot: SafeMaintenanceSnapshot;
  waitingCount: number;
}

export interface SafeMaintenanceCoordinatorOptions {
  filePath?: string;
  now?: () => Date;
  idFactory?: () => string;
  stableIdleMs?: number;
  pollMs?: number;
  autoPoll?: boolean;
}

export interface SafeMaintenanceRuntime {
  getSnapshot(): SafeMaintenanceSnapshot | Promise<SafeMaintenanceSnapshot>;
  execute(kind: SafeMaintenanceKind): Promise<boolean>;
  notify(requester: SafeMaintenanceRequester, message: string): Promise<void>;
}

export const SAFE_MAINTENANCE_FILE = process.env.VITEST
  ? join(tmpdir(), `chatccc-vitest-safe-maintenance-${process.pid}-${randomUUID()}.json`)
  : join(USER_DATA_DIR, "state", "safe-maintenance.json");
export const SAFE_MAINTENANCE_STABLE_IDLE_MS = 1_000;

const EMPTY_SNAPSHOT: SafeMaintenanceSnapshot = {
  activeSessionIds: [],
  queuedSessionIds: [],
  activeEngineIds: [],
  activeWorkLabels: [],
};

export class SafeMaintenanceCoordinator {
  private readonly filePath: string;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly stableIdleMs: number;
  private readonly pollMs: number;
  private readonly autoPoll: boolean;
  private readonly trackedWork = new Map<string, string>();
  private runtime: SafeMaintenanceRuntime | null = null;
  private job: SafeMaintenanceJob | null;
  private snapshot: SafeMaintenanceSnapshot = EMPTY_SNAPSHOT;
  private stableSince: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickRunning = false;

  constructor(options: SafeMaintenanceCoordinatorOptions = {}) {
    this.filePath = options.filePath ?? SAFE_MAINTENANCE_FILE;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.stableIdleMs = options.stableIdleMs ?? SAFE_MAINTENANCE_STABLE_IDLE_MS;
    this.pollMs = options.pollMs ?? 500;
    this.autoPoll = options.autoPoll ?? true;
    this.job = readJob(this.filePath);
  }

  configure(runtime: SafeMaintenanceRuntime): void {
    this.runtime = runtime;
  }

  isAdmissionClosed(): boolean {
    return this.job?.phase === "draining" || this.job?.phase === "executing";
  }

  beginTrackedWork(label: string): () => void {
    const id = this.idFactory();
    this.trackedWork.set(id, label);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.trackedWork.delete(id);
    };
  }

  async schedule(kind: SafeMaintenanceKind, requester: SafeMaintenanceRequester): Promise<SafeMaintenanceJob> {
    const now = this.now().toISOString();
    if (this.job?.phase === "executing") return structuredClone(this.job);
    const previous = this.job;
    if (this.job?.phase === "draining") {
      const requesters = addRequester(this.job.requesters, requester);
      this.job = {
        ...this.job,
        kind: this.job.kind === "update" || kind === "update" ? "update" : "restart",
        requesters,
        updatedAt: now,
      };
    } else {
      this.job = {
        schemaVersion: 1,
        jobId: this.idFactory(),
        kind,
        phase: "draining",
        requestedAt: now,
        updatedAt: now,
        requesters: [requester],
      };
    }
    this.stableSince = null;
    try {
      writeJob(this.filePath, this.job);
    } catch (error) {
      this.job = previous;
      throw error;
    }
    this.startPolling();
    return structuredClone(this.job);
  }

  async cancel(notify = true): Promise<boolean> {
    if (this.job?.phase !== "draining") return false;
    const requesters = this.job.requesters;
    removeJob(this.filePath);
    this.job = null;
    this.snapshot = EMPTY_SNAPSHOT;
    this.stableSince = null;
    this.stopPolling();
    if (notify) await this.notifyAll(requesters, "已取消安全维护预约，ChatCCC 恢复接受新任务。");
    return true;
  }

  async status(): Promise<SafeMaintenanceStatus> {
    if (this.runtime && this.isAdmissionClosed()) this.snapshot = await this.collectSnapshot();
    return {
      job: this.job ? structuredClone(this.job) : null,
      snapshot: structuredClone(this.snapshot),
      waitingCount: snapshotCount(this.snapshot),
    };
  }

  async tick(): Promise<void> {
    if (this.tickRunning || this.job?.phase !== "draining" || !this.runtime) return;
    this.tickRunning = true;
    try {
      this.snapshot = await this.collectSnapshot();
      if (snapshotCount(this.snapshot) > 0) {
        this.stableSince = null;
        return;
      }
      const nowMs = this.now().getTime();
      if (this.stableSince === null) {
        this.stableSince = nowMs;
        return;
      }
      if (nowMs - this.stableSince < this.stableIdleMs) return;
      await this.executeCurrentJob();
    } finally {
      this.tickRunning = false;
    }
  }

  async recoverAfterStartup(internalRestart: boolean): Promise<void> {
    if (!this.job || !this.runtime) return;
    if (this.job.phase === "draining") {
      this.startPolling();
      await this.notifyAll(this.job.requesters, "ChatCCC 已恢复未完成的安全维护预约，继续等待现有任务结束。");
      return;
    }
    if (this.job.phase !== "executing") return;
    if (internalRestart) {
      const completed: SafeMaintenanceJob = { ...this.job, phase: "completed", updatedAt: this.now().toISOString() };
      writeJob(this.filePath, completed);
      this.job = completed;
      await this.notifyAll(
        this.job.requesters,
        this.job.kind === "update" ? "ChatCCC 已安全更新并重新启动。" : "ChatCCC 已安全重新启动。",
      );
      return;
    }
    const message = "安全维护执行期间进程意外退出；为避免重启循环，未自动重试。";
    const failed: SafeMaintenanceJob = {
      ...this.job,
      phase: "failed",
      updatedAt: this.now().toISOString(),
      lastError: message,
    };
    writeJob(this.filePath, failed);
    this.job = failed;
    await this.notifyAll(this.job.requesters, message);
  }

  private async collectSnapshot(): Promise<SafeMaintenanceSnapshot> {
    const external = await this.runtime!.getSnapshot();
    return {
      activeSessionIds: [...external.activeSessionIds],
      queuedSessionIds: [...external.queuedSessionIds],
      activeEngineIds: [...external.activeEngineIds],
      activeWorkLabels: [...external.activeWorkLabels, ...this.trackedWork.values()],
    };
  }

  private async executeCurrentJob(): Promise<void> {
    if (!this.job || !this.runtime) return;
    const executing: SafeMaintenanceJob = { ...this.job, phase: "executing", updatedAt: this.now().toISOString() };
    writeJob(this.filePath, executing);
    this.job = executing;
    this.stopPolling();
    const label = this.job.kind === "update" ? "更新并重启" : "重启";
    await this.notifyAll(this.job.requesters, `现有任务已全部完成，开始安全${label}。`);
    const started = await this.runtime.execute(this.job.kind).catch(async (error) => {
      await this.markFailed(error instanceof Error ? error.message : String(error));
      return false;
    });
    if (!started && this.job?.phase === "executing") {
      await this.markFailed(`安全${label}未能启动，当前进程将继续提供服务。`);
    }
  }

  private async markFailed(message: string): Promise<void> {
    if (!this.job) return;
    const failed: SafeMaintenanceJob = {
      ...this.job,
      phase: "failed",
      updatedAt: this.now().toISOString(),
      lastError: message,
    };
    writeJob(this.filePath, failed);
    this.job = failed;
    await this.notifyAll(this.job.requesters, message);
  }

  private startPolling(): void {
    if (!this.autoPoll || this.timer || this.job?.phase !== "draining") return;
    this.timer = setInterval(() => { void this.tick(); }, this.pollMs);
    this.timer.unref?.();
  }

  private stopPolling(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async notifyAll(requesters: SafeMaintenanceRequester[], message: string): Promise<void> {
    if (!this.runtime) return;
    await Promise.all(requesters.map((requester) => this.runtime!.notify(requester, message).catch(() => {})));
  }
}

function snapshotCount(snapshot: SafeMaintenanceSnapshot): number {
  return snapshot.activeSessionIds.length
    + snapshot.queuedSessionIds.length
    + snapshot.activeEngineIds.length
    + snapshot.activeWorkLabels.length;
}

function addRequester(
  requesters: SafeMaintenanceRequester[],
  requester: SafeMaintenanceRequester,
): SafeMaintenanceRequester[] {
  if (requesters.some((item) => item.platform === requester.platform && item.chatId === requester.chatId)) return requesters;
  return [...requesters, requester];
}

function readJob(filePath: string): SafeMaintenanceJob | null {
  if (!existsSync(filePath)) return null;
  try {
    const value = JSON.parse(readFileSync(filePath, "utf8")) as SafeMaintenanceJob;
    if (value.schemaVersion !== 1 || !value.jobId || !Array.isArray(value.requesters)) return null;
    if (!["restart", "update"].includes(value.kind) || !["draining", "executing", "completed", "failed"].includes(value.phase)) return null;
    return value;
  } catch {
    return null;
  }
}

function writeJob(filePath: string, job: SafeMaintenanceJob): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(job, null, 2)}\n`, "utf8");
    renameSync(temporary, filePath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function removeJob(filePath: string): void {
  rmSync(filePath, { force: true });
}

export let safeMaintenanceCoordinator = new SafeMaintenanceCoordinator();

export function _setSafeMaintenanceCoordinatorForTest(coordinator: SafeMaintenanceCoordinator): void {
  safeMaintenanceCoordinator = coordinator;
}

export function _resetSafeMaintenanceCoordinatorForTest(): void {
  safeMaintenanceCoordinator = new SafeMaintenanceCoordinator();
}

export function isSafeMaintenanceAdmissionClosed(): boolean {
  return safeMaintenanceCoordinator.isAdmissionClosed();
}

export function beginSafeMaintenanceTrackedWork(label: string): () => void {
  return safeMaintenanceCoordinator.beginTrackedWork(label);
}
