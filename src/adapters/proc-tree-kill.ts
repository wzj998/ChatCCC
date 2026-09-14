// Process groups are created by cliProcessOptions on POSIX. Never target a
// shared parent group. A false result means callers must retain ownership.
import { spawn, execFile } from "node:child_process";

const pending = new Map<number, Promise<boolean>>();
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

export interface PosixTerminationDeps {
  signal(target: number, signal: NodeJS.Signals): void;
  hasLiveMembers(pid: number): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

/** Confirm the group, not only its leader: descendants may outlive the shell. */
export async function terminatePosixGroup(pid: number, deps: PosixTerminationDeps): Promise<boolean> {
  const send = (target: number, signal: NodeJS.Signals) => {
    try { deps.signal(target, signal); } catch { /* confirmation below decides success */ }
  };
  send(-pid, "SIGTERM");
  send(pid, "SIGTERM");
  for (let attempt = 0; attempt < 10; attempt++) {
    if (!await deps.hasLiveMembers(pid)) return true;
    await deps.sleep(100);
  }
  send(-pid, "SIGKILL");
  send(pid, "SIGKILL");
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!await deps.hasLiveMembers(pid)) return true;
    await deps.sleep(100);
  }
  return !await deps.hasLiveMembers(pid);
}

function posixMembersAlive(pid: number): Promise<boolean> {
  return new Promise(resolve => {
    execFile("ps", ["-eo", "pid=,pgid=,stat="], { timeout: 2_000, maxBuffer: 4 * 1024 * 1024 }, (error, output) => {
      if (error) { resolve(alive(-pid) || alive(pid)); return; }
      // Zombies have already released files/locks; waiting for init to reap
      // them would otherwise block containers with a non-reaping PID 1.
      resolve(output.split("\n").some(line => {
        const [id, group, state] = line.trim().split(/\s+/);
        return (Number(id) === pid || Number(group) === pid) && !!state && !/^[ZX]/.test(state);
      }));
    });
  });
}

function killWindowsTree(pid: number): Promise<boolean> {
  if (!alive(pid)) return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const done = (ok: boolean) => { if (!settled) { settled = true; clearTimeout(timer); resolve(ok); } };
    timer = setTimeout(() => done(false), 5_000);
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.once("error", () => done(false));
      killer.once("close", (code) => done(code === 0 && !alive(pid)));
    } catch { done(false); }
  });
}

/** Coalesce abort/watchdog/finally calls; success requires observed termination. */
export function killProcessTree(pid: number | undefined): Promise<boolean> {
  if (pid == null) return Promise.resolve(true);
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || pid === process.ppid) return Promise.resolve(false);
  const existing = pending.get(pid);
  if (existing) return existing;
  const operation = (process.platform === "win32" ? killWindowsTree(pid) : terminatePosixGroup(pid, {
    signal: (target, signal) => { process.kill(target, signal); }, hasLiveMembers: posixMembersAlive, sleep: delay,
  })).catch(() => false).then(ok => {
    if (!ok) console.error(`[killProcessTree] cleanup not confirmed for PID ${pid}`);
    return ok;
  }).finally(() => pending.delete(pid));
  pending.set(pid, operation);
  return operation;
}
