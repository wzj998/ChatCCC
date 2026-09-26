import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const READY_MESSAGE = "chatccc:self-update-helper-ready";
const INTERNAL_RESTART_ENV = "CHATCCC_INTERNAL_RESTART";
const RESTART_PARENT_PID_ENV = "CHATCCC_RESTART_PARENT_PID";
const UPDATE_RESULT_ENV = "CHATCCC_SELF_UPDATE_RESULT";
const UPDATE_ERROR_ENV = "CHATCCC_SELF_UPDATE_ERROR";

function log(message, details) {
  const suffix = details === undefined
    ? ""
    : ` ${typeof details === "string" ? details : JSON.stringify(details)}`;
  console.log(`${new Date().toISOString()} [UPDATE-HELPER] ${message}${suffix}`);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForParentExit(parentPid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (pidIsAlive(parentPid)) {
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
  // npm 的 bin 包装器会在主进程结束后才从 spawnSync 返回；留出短暂时间，
  // 让包装器也退出并释放它继承的 Windows 当前目录句柄。
  await sleep(300);
  return true;
}

function readInstalledPackage(job) {
  const packageJsonPath = resolve(job.packageRoot, "package.json");
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (parsed?.name !== "chatccc" || typeof parsed.version !== "string") {
    throw new Error("安装后的 package.json 无效。");
  }
  if (!existsSync(job.runtimeEntry)) {
    throw new Error(`安装后的运行入口不存在：${job.runtimeEntry}`);
  }
  return parsed;
}

function runNpmInstall(job, packageSpec) {
  const args = [
    ...job.npmArgsPrefix,
    "install",
    "-g",
    packageSpec,
    "--no-audit",
    "--no-fund",
  ];
  log("npm install begin", {
    command: job.npmCommand,
    args,
    cwd: job.restartCwd,
  });
  const result = spawnSync(job.npmCommand, args, {
    cwd: job.restartCwd,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 180_000,
    windowsHide: true,
    shell: false,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  log("npm install end", {
    packageSpec,
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
    output: output.slice(-4_000),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm install ${packageSpec} 失败（退出码 ${result.status ?? "unknown"}）：${output.slice(-1_000)}`);
  }
}

async function installWithRetry(job, packageSpec) {
  const attempts = Number.isInteger(job.maxInstallAttempts) && job.maxInstallAttempts > 0
    ? job.maxInstallAttempts
    : 3;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      runNpmInstall(job, packageSpec);
      return;
    } catch (error) {
      lastError = error;
      log("npm install attempt failed", {
        packageSpec,
        attempt,
        attempts,
        error: error instanceof Error ? error.message : String(error),
      });
      if (attempt < attempts) await sleep(500 * attempt);
    }
  }
  throw lastError ?? new Error(`npm install ${packageSpec} 失败。`);
}

function persistResult(job, result) {
  const temporary = `${job.resultFile}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({
    schemaVersion: 1,
    completedAt: new Date().toISOString(),
    ...result,
  }, null, 2), "utf8");
  renameSync(temporary, job.resultFile);
}

function markSafeUpdateFailed(job, message) {
  if (!job.safeMaintenanceFile || !existsSync(job.safeMaintenanceFile)) return;
  try {
    const current = JSON.parse(readFileSync(job.safeMaintenanceFile, "utf8"));
    if (current?.kind !== "update" || current.phase !== "executing") return;
    const failed = {
      ...current,
      phase: "failed",
      updatedAt: new Date().toISOString(),
      lastError: message,
    };
    const temporary = `${job.safeMaintenanceFile}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(failed, null, 2), "utf8");
    renameSync(temporary, job.safeMaintenanceFile);
    log("safe update state marked failed");
  } catch (error) {
    log("failed to persist safe update failure", error instanceof Error ? error.message : String(error));
  }
}

function launchRuntime(job, status, errorMessage) {
  const env = {
    ...process.env,
    [INTERNAL_RESTART_ENV]: "1",
    [RESTART_PARENT_PID_ENV]: String(process.pid),
    [UPDATE_RESULT_ENV]: status,
  };
  if (errorMessage) env[UPDATE_ERROR_ENV] = errorMessage.slice(0, 2_000);
  const child = spawn(job.runtimeCommand, [job.runtimeEntry], {
    cwd: job.restartCwd,
    detached: true,
    stdio: ["ignore", "ignore", "inherit"],
    shell: false,
    windowsHide: true,
    env,
  });
  child.unref();
  log("runtime launched", {
    pid: child.pid,
    status,
    command: job.runtimeCommand,
    entry: job.runtimeEntry,
    cwd: job.restartCwd,
  });
}

function validateJob(job) {
  if (
    job?.schemaVersion !== 1
    || !Number.isInteger(job.parentPid)
    || job.parentPid <= 0
    || typeof job.packageRoot !== "string"
    || typeof job.previousVersion !== "string"
    || typeof job.restartCwd !== "string"
    || typeof job.npmCommand !== "string"
    || !Array.isArray(job.npmArgsPrefix)
    || !job.npmArgsPrefix.every((arg) => typeof arg === "string")
    || typeof job.runtimeCommand !== "string"
    || typeof job.runtimeEntry !== "string"
    || typeof job.resultFile !== "string"
    || (job.safeMaintenanceFile !== undefined && typeof job.safeMaintenanceFile !== "string")
    || (job.cleanupPaths !== undefined && (
      !Array.isArray(job.cleanupPaths)
      || !job.cleanupPaths.every((path) => typeof path === "string")
    ))
  ) {
    throw new Error("自更新任务文件无效。");
  }
  return job;
}

async function announceReady(job) {
  if (typeof process.send !== "function") return;
  await new Promise((resolvePromise) => {
    try {
      process.send({
        type: READY_MESSAGE,
        pid: process.pid,
        parentPid: job.parentPid,
      }, () => resolvePromise());
    } catch {
      resolvePromise();
    }
  });
  try { process.disconnect?.(); } catch { /* parent may disconnect first */ }
}

export async function runSelfUpdateJob(job) {
  const parentExited = await waitForParentExit(
    job.parentPid,
    job.parentExitTimeoutMs ?? 30_000,
  );
  if (!parentExited) {
    throw new Error(`旧 ChatCCC 进程 ${job.parentPid} 未在限定时间内退出，已取消更新。`);
  }

  try {
    await installWithRetry(job, "chatccc@latest");
    const installed = readInstalledPackage(job);
    persistResult(job, {
      status: "success",
      previousVersion: job.previousVersion,
      installedVersion: installed.version,
      rollbackSucceeded: false,
    });
    launchRuntime(job, "success");
  } catch (updateError) {
    const message = updateError instanceof Error ? updateError.message : String(updateError);
    log("latest installation failed; rollback begin", {
      previousVersion: job.previousVersion,
      error: message,
    });
    let rollbackSucceeded = false;
    try {
      await installWithRetry(job, `chatccc@${job.previousVersion}`);
      readInstalledPackage(job);
      rollbackSucceeded = true;
    } catch (rollbackError) {
      log("rollback failed", rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
      // npm 可能只在 postinstall 等末尾步骤失败；若入口仍完整，则优先恢复服务。
      try {
        readInstalledPackage(job);
        rollbackSucceeded = true;
        log("existing runtime remains usable after rollback failure");
      } catch {
        // 包目录确实不可用，只能保留结果和日志供人工恢复。
      }
    }
    persistResult(job, {
      status: "failed",
      previousVersion: job.previousVersion,
      rollbackSucceeded,
      error: message,
    });
    markSafeUpdateFailed(job, message);
    if (!rollbackSucceeded) {
      throw new Error(`更新失败且无法恢复旧版本：${message}`);
    }
    launchRuntime(job, "failed", message);
  }
}

async function main() {
  const jobPath = process.argv[2];
  if (!jobPath) throw new Error("缺少自更新任务文件路径。");
  const job = validateJob(JSON.parse(readFileSync(jobPath, "utf8")));
  log("helper started", {
    pid: process.pid,
    parentPid: job.parentPid,
    packageRoot: job.packageRoot,
    helper: basename(process.argv[1]),
  });
  await announceReady(job);
  try {
    await runSelfUpdateJob(job);
  } finally {
    for (const path of job.cleanupPaths ?? []) {
      try { rmSync(path, { force: true }); } catch { /* best effort */ }
    }
  }
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((error) => {
    log("fatal", error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
