import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SELF_UPDATE_HELPER_READY_MESSAGE,
  spawnSelfUpdateHelper,
  waitForSelfUpdateHelperReady,
  type SelfUpdateJob,
} from "../self-update.ts";

const execFileAsync = promisify(execFile);

class FakeChild extends EventEmitter {
  pid = 54321;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  connected = true;
  disconnect = vi.fn(() => { this.connected = false; });
  kill = vi.fn(() => true);
  unref = vi.fn();
}

describe("detached self updater", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
    tempDirs.length = 0;
  });

  async function tempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  it("copies the helper outside the npm package and starts it from a safe cwd", async () => {
    const projectRoot = await tempDir("chatccc-update-package-");
    const userDataDir = await tempDir("chatccc-update-user-");
    const helperSourcePath = join(projectRoot, "scripts", "self-update-helper.mjs");
    await mkdir(join(projectRoot, "scripts"), { recursive: true });
    await mkdir(join(projectRoot, "dist", "src"), { recursive: true });
    await writeFile(join(projectRoot, "package.json"), JSON.stringify({
      name: "chatccc",
      version: "1.2.3",
    }), "utf8");
    await writeFile(join(projectRoot, "dist", "src", "index.js"), "", "utf8");
    await writeFile(helperSourcePath, "process.send?.({ type: 'unused' });\n", "utf8");

    const fake = new FakeChild();
    const spawnImpl = vi.fn(() => fake as never);
    const child = spawnSelfUpdateHelper({
      projectRoot,
      userDataDir,
      helperSourcePath,
      parentPid: 9876,
      npmInvocation: {
        command: process.execPath,
        argsPrefix: ["C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js"],
      },
      spawnImpl,
    });

    expect(child).toBe(fake);
    const [command, args, options] = spawnImpl.mock.calls[0] as unknown as [
      string,
      string[],
      { cwd: string; detached: boolean; shell: boolean; stdio: unknown[] },
    ];
    expect(command).toBe(process.execPath);
    expect(resolve(args[0]).startsWith(resolve(projectRoot))).toBe(false);
    expect(resolve(args[1]).startsWith(resolve(projectRoot))).toBe(false);
    expect(options).toEqual(expect.objectContaining({
      cwd: userDataDir,
      detached: true,
      shell: false,
    }));
    expect(options.stdio[3]).toBe("ipc");

    const job = JSON.parse(await readFile(args[1], "utf8")) as SelfUpdateJob;
    expect(job).toEqual(expect.objectContaining({
      schemaVersion: 1,
      parentPid: 9876,
      packageRoot: projectRoot,
      previousVersion: "1.2.3",
      restartCwd: userDataDir,
      npmCommand: process.execPath,
      npmArgsPrefix: ["C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js"],
    }));
  });

  it("lets the parent exit only after the external helper announces readiness", async () => {
    const child = new FakeChild();
    const ready = waitForSelfUpdateHelperReady(child as never, 500);
    child.emit("message", {
      type: SELF_UPDATE_HELPER_READY_MESSAGE,
      pid: child.pid,
      parentPid: process.pid,
    });

    await expect(ready).resolves.toBe(true);
    expect(child.disconnect).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("keeps the parent alive and terminates a helper that never becomes ready", async () => {
    const child = new FakeChild();

    await expect(waitForSelfUpdateHelperReady(child as never, 20)).resolves.toBe(false);

    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("waits for the old process, installs with structured argv, and launches the new runtime", async () => {
    const root = await tempDir("chatccc-update-helper-");
    const packageRoot = join(root, "global", "node_modules", "chatccc");
    const restartMarker = join(root, "restart.json");
    const npmArgsMarker = join(root, "npm-args.json");
    const resultFile = join(root, "result.json");
    await mkdir(join(packageRoot, "dist", "src"), { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({
      name: "chatccc",
      version: "1.2.3",
    }), "utf8");
    await writeFile(join(packageRoot, "dist", "src", "index.js"), [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(restartMarker)}, JSON.stringify({ result: process.env.CHATCCC_SELF_UPDATE_RESULT, cwd: process.cwd() }));`,
    ].join("\n"), "utf8");
    const fakeNpm = join(root, "fake-npm.mjs");
    await writeFile(fakeNpm, [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(npmArgsMarker)}, JSON.stringify(process.argv.slice(2)));`,
      `writeFileSync(${JSON.stringify(join(packageRoot, "package.json"))}, JSON.stringify({ name: 'chatccc', version: '1.2.4' }));`,
    ].join("\n"), "utf8");
    const jobPath = join(root, "job.json");
    const job: SelfUpdateJob = {
      schemaVersion: 1,
      parentPid: 99_999_999,
      packageRoot,
      previousVersion: "1.2.3",
      restartCwd: root,
      npmCommand: process.execPath,
      npmArgsPrefix: [fakeNpm],
      runtimeCommand: process.execPath,
      runtimeEntry: join(packageRoot, "dist", "src", "index.js"),
      resultFile,
      maxInstallAttempts: 1,
      parentExitTimeoutMs: 100,
    };
    await writeFile(jobPath, JSON.stringify(job), "utf8");

    await execFileAsync(process.execPath, [
      join(process.cwd(), "scripts", "self-update-helper.mjs"),
      jobPath,
    ], { cwd: root, timeout: 10_000 });

    const npmArgs = JSON.parse(await readFile(npmArgsMarker, "utf8")) as string[];
    expect(npmArgs).toEqual([
      "install",
      "-g",
      "chatccc@latest",
      "--no-audit",
      "--no-fund",
    ]);
    const result = JSON.parse(await readFile(resultFile, "utf8")) as { status: string; installedVersion: string };
    expect(result).toEqual(expect.objectContaining({
      status: "success",
      installedVersion: "1.2.4",
    }));
    const restart = JSON.parse(await readFile(restartMarker, "utf8")) as { result: string; cwd: string };
    expect(restart).toEqual({ result: "success", cwd: root });
  });

  it("reinstalls the previous version and reports failure when latest installation fails", async () => {
    const root = await tempDir("chatccc-update-rollback-");
    const packageRoot = join(root, "global", "node_modules", "chatccc");
    const restartMarker = join(root, "rollback-restart.json");
    const npmCallsMarker = join(root, "npm-calls.log");
    const resultFile = join(root, "result.json");
    const safeMaintenanceFile = join(root, "safe-maintenance.json");
    await mkdir(join(packageRoot, "dist", "src"), { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({
      name: "chatccc",
      version: "1.2.3",
    }), "utf8");
    await writeFile(join(packageRoot, "dist", "src", "index.js"), [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(restartMarker)}, process.env.CHATCCC_SELF_UPDATE_RESULT ?? 'missing');`,
    ].join("\n"), "utf8");
    await writeFile(safeMaintenanceFile, JSON.stringify({
      schemaVersion: 1,
      jobId: "update-1",
      kind: "update",
      phase: "executing",
      requesters: [],
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }), "utf8");
    const fakeNpm = join(root, "fake-npm-fail.mjs");
    await writeFile(fakeNpm, [
      "import { appendFileSync, writeFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(npmCallsMarker)}, process.argv.slice(2).join(' ') + '\\n');`,
      "const spec = process.argv.find((arg) => arg.startsWith('chatccc@'));",
      "if (spec === 'chatccc@latest') process.exit(23);",
      `writeFileSync(${JSON.stringify(join(packageRoot, "package.json"))}, JSON.stringify({ name: 'chatccc', version: '1.2.3' }));`,
    ].join("\n"), "utf8");
    const jobPath = join(root, "job.json");
    const job: SelfUpdateJob = {
      schemaVersion: 1,
      parentPid: 99_999_999,
      packageRoot,
      previousVersion: "1.2.3",
      restartCwd: root,
      npmCommand: process.execPath,
      npmArgsPrefix: [fakeNpm],
      runtimeCommand: process.execPath,
      runtimeEntry: join(packageRoot, "dist", "src", "index.js"),
      resultFile,
      safeMaintenanceFile,
      maxInstallAttempts: 1,
      parentExitTimeoutMs: 100,
    };
    await writeFile(jobPath, JSON.stringify(job), "utf8");

    await execFileAsync(process.execPath, [
      join(process.cwd(), "scripts", "self-update-helper.mjs"),
      jobPath,
    ], { cwd: root, timeout: 10_000 });

    const calls = await readFile(npmCallsMarker, "utf8");
    expect(calls).toContain("chatccc@latest");
    expect(calls).toContain("chatccc@1.2.3");
    const result = JSON.parse(await readFile(resultFile, "utf8")) as { status: string; rollbackSucceeded: boolean };
    expect(result).toEqual(expect.objectContaining({
      status: "failed",
      rollbackSucceeded: true,
    }));
    expect(JSON.parse(await readFile(safeMaintenanceFile, "utf8"))).toEqual(expect.objectContaining({
      phase: "failed",
      lastError: expect.stringContaining("退出码 23"),
    }));
    expect(await readFile(restartMarker, "utf8")).toBe("failed");
  });
});
