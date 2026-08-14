import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createCoalescedAsyncTask, EngineManager, resolveNpmInvocation, type EngineSpec } from "../engines/engine-manager.ts";

function testSpec(version = "1.2.3"): EngineSpec {
  return {
    id: "test",
    label: "Test Engine",
    version,
    packages: { "@example/engine": version },
    entryRelativePath: join("node_modules", "@example", "engine", "index.js"),
    expectedBytes: 1024,
    minimumNodeVersion: "20.0.0",
  };
}

async function fakeInstall(dir: string, spec: EngineSpec): Promise<void> {
  const pkgDir = join(dir, "node_modules", "@example", "engine");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(pkgDir, "package.json"), JSON.stringify({ version: spec.version }), "utf8");
  await writeFile(join(pkgDir, "index.js"), "export default true\n", "utf8");
}

describe("EngineManager", () => {
  it("launches npm through node and npm-cli.js without a command shell", () => {
    const invocation = resolveNpmInvocation();
    expect(invocation.command).toBe(process.execPath);
    expect(invocation.argsPrefix[0].replaceAll("\\", "/")).toMatch(/\/npm\/bin\/npm-cli\.js$/);
  });

  it("coalesces noisy progress events instead of queueing one directory scan per event", async () => {
    let runs = 0;
    let releaseFirst!: () => void;
    const firstRun = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const reporter = createCoalescedAsyncTask(async () => {
      runs += 1;
      if (runs === 1) await firstRun;
    });

    reporter.schedule();
    await Promise.resolve();
    for (let index = 0; index < 100; index += 1) reporter.schedule();
    expect(runs).toBe(1);

    releaseFirst();
    await reporter.flush();
    expect(runs).toBe(2);
  });

  it("installs into staging, verifies, and atomically publishes current.json", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "chatccc-engine-manager-"));
    const manager = new EngineManager({
      rootDir,
      specs: [testSpec()],
      installPackages: fakeInstall,
      verifyRuntime: async () => {},
    });

    const job = await manager.install("test");
    expect(job.state).toBe("succeeded");
    expect(job.steps.every((step) => step.state === "completed")).toBe(true);

    const status = await manager.getStatus("test");
    expect(status.installed).toBe(true);
    expect(status.version).toBe("1.2.3");
    expect(status.entryPath && existsSync(status.entryPath)).toBe(true);

    const pointer = JSON.parse(await readFile(join(rootDir, "test", "current.json"), "utf8"));
    expect(pointer.version).toBe("1.2.3");
    expect(pointer.directory).toMatch(/^versions\//);
  });

  it("keeps the working version active when verification fails", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "chatccc-engine-rollback-"));
    const first = new EngineManager({
      rootDir,
      specs: [testSpec("1.0.0")],
      installPackages: fakeInstall,
      verifyRuntime: async () => {},
    });
    await first.install("test");
    const oldEntry = (await first.getStatus("test")).entryPath;

    const upgrade = new EngineManager({
      rootDir,
      specs: [testSpec("2.0.0")],
      installPackages: fakeInstall,
      verifyRuntime: async () => { throw new Error("handshake failed"); },
    });
    const failed = await upgrade.install("test");
    expect(failed.state).toBe("failed");
    expect(failed.steps.find((step) => step.id === "runtime_handshake")?.state).toBe("failed");

    const status = await upgrade.getStatus("test");
    expect(status.installed).toBe(true);
    expect(status.version).toBe("1.0.0");
    expect(status.entryPath).toBe(oldEntry);
  });

  it("persists every visible step so a refreshed page can recover progress", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "chatccc-engine-progress-"));
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const manager = new EngineManager({
      rootDir,
      specs: [testSpec()],
      installPackages: async (dir, spec) => {
        await paused;
        await fakeInstall(dir, spec);
      },
      verifyRuntime: async () => {},
    });

    const started = await manager.startInstall("test");
    expect(started.state).toBe("running");
    const snapshot = await manager.getStatus("test");
    expect(snapshot.job?.state).toBe("running");
    expect(snapshot.job?.steps.map((step) => step.id)).toEqual([
      "preflight",
      "prepare",
      "download_install",
      "verify_packages",
      "runtime_handshake",
      "activate",
      "cleanup",
    ]);
    release();
    expect((await manager.waitForInstall("test")).state).toBe("succeeded");
  });

  it("deduplicates concurrent one-click install requests", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "chatccc-engine-lock-"));
    let installs = 0;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const manager = new EngineManager({
      rootDir,
      specs: [testSpec()],
      installPackages: async (dir, spec) => {
        installs += 1;
        markStarted();
        await paused;
        await fakeInstall(dir, spec);
      },
      verifyRuntime: async () => {},
    });

    const first = await manager.startInstall("test");
    const second = await manager.startInstall("test");
    expect(second.jobId).toBe(first.jobId);
    await started;
    release();
    await manager.waitForInstall("test");
    expect(installs).toBe(1);
  });
});
