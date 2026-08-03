import { spawn } from "node:child_process";

/**
 * Best-effort process-tree termination.
 *
 * Commands are spawned through a platform shell, so the pid we get is often
 * the outer shell process. Killing only that process can leave the real child
 * command running. This helper targets the whole process tree on Windows and
 * the process group on POSIX when possible.
 */
export async function killProcessTree(pid: number | undefined): Promise<void> {
  if (pid == null || !Number.isFinite(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    await killWindowsTree(pid);
    return;
  }
  await killPosixTree(pid);
}

function killWindowsTree(pid: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };

    try {
      const proc = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      proc.once("error", (err) => {
        console.warn(`[killProcessTree] taskkill spawn error for pid=${pid}: ${(err as Error).message}`);
        done();
      });
      proc.once("close", () => { done(); });
      setTimeout(done, 3000).unref();
    } catch (err) {
      console.warn(`[killProcessTree] taskkill failed for pid=${pid}: ${(err as Error).message}`);
      done();
    }
  });
}

async function killPosixTree(pid: number): Promise<void> {
  trySignal(-pid, "SIGTERM");
  trySignal(pid, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  trySignal(-pid, "SIGKILL");
  trySignal(pid, "SIGKILL");
}

function trySignal(target: number, signal: NodeJS.Signals): void {
  try {
    process.kill(target, signal);
  } catch {
    // Process is already gone or cannot be signaled.
  }
}
