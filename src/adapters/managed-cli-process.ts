import { killProcessTree } from "./proc-tree-kill.ts";

export function cliProcessOptions(platform: NodeJS.Platform = process.platform) {
  return { detached: platform !== "win32" };
}

interface Owner {
  stopping: boolean;
  stop(): Promise<void>;
}
const owners = new Map<string, Owner>();
export class ProcessCleanupError extends Error {
  readonly code = "PROCESS_CLEANUP_FAILED";
}

/** A new adapter instance must not bypass a previous failed cleanup. */
export async function ensureCliSessionReleased(sessionId: string): Promise<void> {
  const owner = owners.get(sessionId);
  if (!owner) return;
  if (!owner.stopping) throw new Error("该会话的 Agent 仍在执行，暂不能启动另一个进程");
  await owner.stop();
}

export function ownCliProcess(sessionId: string, pid: number | undefined): Owner {
  let pending: Promise<void> | undefined;
  let finished = false;
  const owner: Owner = {
    stopping: false,
    stop() {
      if (finished) return Promise.resolve();
      if (pending) return pending;
      owner.stopping = true;
      pending = killProcessTree(pid).then(ok => {
        if (ok === false) throw new ProcessCleanupError(`Agent 进程未确认退出（PID ${pid}），会话仍受保护；请重试停止或检查残留进程后再继续。`);
        finished = true;
        if (owners.get(sessionId) === owner) owners.delete(sessionId);
      }).finally(() => { pending = undefined; });
      return pending;
    },
  };
  // Test/non-process adapters can have no PID; they own no OS resource.
  if (pid !== undefined) owners.set(sessionId, owner);
  return owner;
}
