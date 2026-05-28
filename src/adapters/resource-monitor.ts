// =============================================================================
// resource-monitor.ts — CLI 进程资源监控（CPU + 内存）
// =============================================================================
// 对所有 chatccc 启动的 CLI 进程持续监控 CPU 和内存占用。
// 若连续 3 分钟两项指标均无变化，判定为僵死，发出 "stuck" 事件。
// =============================================================================

import { exec } from "node:child_process";
import { EventEmitter } from "node:events";

const CHECK_INTERVAL_MS = 30_000; // 30 秒检查一次
const STUCK_THRESHOLD = 6; // 连续 6 次无变化 = 3 分钟

interface ProcessSnapshot {
  cpu: number;
  memory: number;
  unchangedCount: number;
}

interface TrackedProcess {
  pid: number;
  sessionId: string;
  snapshot: ProcessSnapshot;
}

export const resourceMonitor = new EventEmitter();

const tracked = new Map<number, TrackedProcess>();

let timer: ReturnType<typeof setInterval> | null = null;

function startIfNeeded(): void {
  if (timer) return;
  timer = setInterval(checkAll, CHECK_INTERVAL_MS);
  timer.unref?.();
}

function stopIfIdle(): void {
  if (tracked.size > 0) return;
  if (timer) { clearInterval(timer); timer = null; }
}

export function registerProcess(pid: number, sessionId: string): void {
  tracked.set(pid, { pid, sessionId, snapshot: { cpu: -1, memory: -1, unchangedCount: 0 } });
  startIfNeeded();
}

export function unregisterProcess(pid: number): void {
  tracked.delete(pid);
  stopIfIdle();
}

// ---------------------------------------------------------------------------
// 批量查询进程指标（Windows PowerShell）
// ---------------------------------------------------------------------------

function execPowerShell(script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(
      `powershell -NoProfile -Command "${script}"`,
      { timeout: timeoutMs, windowsHide: true },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      },
    );
  });
}

async function getProcessMetrics(pids: number[]): Promise<Map<number, { cpu: number; memory: number }>> {
  const result = new Map<number, { cpu: number; memory: number }>();
  if (pids.length === 0) return result;

  const psScript = `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)|$($_.CPU)|$($_.WorkingSet64)" }`;

  try {
    const stdout = await execPowerShell(psScript, 10_000);
    for (const line of stdout.trim().split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [idStr, cpuStr, memStr] = trimmed.split("|");
      const id = parseInt(idStr, 10);
      const cpu = parseFloat(cpuStr);
      const memory = parseInt(memStr, 10);
      if (!isNaN(id) && !isNaN(cpu) && !isNaN(memory)) {
        result.set(id, { cpu, memory });
      }
    }
  } catch {
    // PowerShell 查询失败时跳过本轮，下次重试
  }

  return result;
}

// ---------------------------------------------------------------------------
// 定时检查
// ---------------------------------------------------------------------------

async function checkAll(): Promise<void> {
  if (tracked.size === 0) return;

  const pids = [...tracked.keys()];
  const metrics = await getProcessMetrics(pids);

  for (const [pid, tp] of tracked) {
    const m = metrics.get(pid);
    if (!m) {
      // 进程已不存在，停止追踪
      tracked.delete(pid);
      continue;
    }

    const prev = tp.snapshot;
    const cpuChanged = m.cpu !== prev.cpu;
    // 内存允许 ±1% 波动，避免正常抖动触发误判
    const memTolerance = prev.memory > 0 ? Math.max(prev.memory * 0.01, 1024 * 1024) : 1024 * 1024;
    const memChanged = Math.abs(m.memory - prev.memory) > memTolerance;

    if (!cpuChanged && !memChanged) {
      tp.snapshot.unchangedCount++;
      if (tp.snapshot.unchangedCount >= STUCK_THRESHOLD) {
        const idleMinutes = Math.round(
          (tp.snapshot.unchangedCount * CHECK_INTERVAL_MS) / 60_000,
        );
        resourceMonitor.emit("stuck", {
          pid: tp.pid,
          sessionId: tp.sessionId,
          idleMinutes,
        });
        tracked.delete(pid);
      }
    } else {
      tp.snapshot.unchangedCount = 0;
    }
    tp.snapshot.cpu = m.cpu;
    tp.snapshot.memory = m.memory;
  }

  stopIfIdle();
}