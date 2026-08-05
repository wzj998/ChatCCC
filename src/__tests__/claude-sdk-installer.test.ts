import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_SDK_VERSION,
  getClaudeSdkEntryPath,
  getClaudeSdkInstalledVersion,
  installClaudeSdk,
  isClaudeSdkInstalled,
  isClaudeSdkInstalling,
  type SdkInstallProgress,
} from "../claude-sdk-installer.ts";

// ---------------------------------------------------------------------------
// 工具：fake npm（可执行脚本，模拟安装过程并伪造产物）
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function makeTempDir(prefix = "claude-sdk-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 伪造 SDK 产物：node_modules/@anthropic-ai/claude-agent-sdk/package.json */
function fakeInstallArtifact(dir: string, version: string = CLAUDE_SDK_VERSION): void {
  const pkgDir = join(dir, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version }),
    "utf8",
  );
}

/** 生成 fake npm 可执行脚本，行为由环境变量控制（FAKE_NPM_FAIL / FAKE_NPM_SLEEP） */
function makeFakeNpmCommand(workDir: string): string {
  const mjs = join(workDir, "fake-npm.mjs");
  writeFileSync(
    mjs,
    [
      'import fs from "node:fs";',
      'const args = process.argv.slice(2);',
      'const prefixIdx = args.indexOf("--prefix");',
      'const dir = prefixIdx >= 0 ? args[prefixIdx + 1] : null;',
      'const pkg = args.find((a) => a.startsWith("@anthropic-ai/claude-agent-sdk@"));',
      'const version = pkg ? pkg.split("@").pop() : "0.0.0";',
      'if (dir) {',
      '  fs.mkdirSync(dir + "/node_modules/@anthropic-ai/claude-agent-sdk", { recursive: true });',
      '  fs.writeFileSync(dir + "/node_modules/@anthropic-ai/claude-agent-sdk/package.json", JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version }));',
      "}",
      'console.log("npm http fetch GET 200 https://registry.npmjs.org/fake");',
      'console.log("npm http fetch GET 200 https://registry.npmjs.org/fake2");',
      'if (process.env.FAKE_NPM_SLEEP) {',
      "  await new Promise((r) => setTimeout(r, Number(process.env.FAKE_NPM_SLEEP)));",
      "}",
      'if (process.env.FAKE_NPM_FAIL === "1") process.exit(1);',
      "process.exit(0);",
      "",
    ].join("\n"),
    "utf8",
  );

  if (process.platform === "win32") {
    const cmd = join(workDir, "fake-npm.cmd");
    const winPath = mjs.replace(/\//g, "\\");
    writeFileSync(
      cmd,
      ["@echo off", `node "${winPath}" %*`, ""].join("\r\n"),
      "utf8",
    );
    return cmd;
  }
  const sh = join(workDir, "fake-npm.sh");
  writeFileSync(sh, `#!/bin/sh\nexec node "${mjs}" "$@"\n`, "utf8");
  // chmod +x
  try {
    chmodSync(sh, 0o755);
  } catch {
    // POSIX only
  }
  return sh;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不阻塞
    }
  }
});

// ---------------------------------------------------------------------------
// 状态查询
// ---------------------------------------------------------------------------

describe("claude-sdk-installer 状态查询", () => {
  it("getClaudeSdkEntryPath 指向 sdk.mjs 入口", () => {
    const dir = makeTempDir();
    const entry = getClaudeSdkEntryPath(dir);
    expect(entry).toContain(join("node_modules", "@anthropic-ai", "claude-agent-sdk"));
    expect(entry.endsWith("sdk.mjs")).toBe(true);
  });

  it("isClaudeSdkInstalled：空目录为 false，有 package.json 为 true", () => {
    const dir = makeTempDir();
    expect(isClaudeSdkInstalled(dir)).toBe(false);
    fakeInstallArtifact(dir);
    expect(isClaudeSdkInstalled(dir)).toBe(true);
  });

  it("getClaudeSdkInstalledVersion：读取版本号", () => {
    const dir = makeTempDir();
    expect(getClaudeSdkInstalledVersion(dir)).toBeNull();
    fakeInstallArtifact(dir, "9.9.9");
    expect(getClaudeSdkInstalledVersion(dir)).toBe("9.9.9");
  });

  it("getClaudeSdkInstalledVersion：损坏 JSON 返回 null", () => {
    const dir = makeTempDir();
    const pkgDir = join(dir, "node_modules", "@anthropic-ai", "claude-agent-sdk");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), "{ not json", "utf8");
    expect(getClaudeSdkInstalledVersion(dir)).toBeNull();
  });

  it("isClaudeSdkInstalling：无锁为 false", () => {
    const dir = makeTempDir();
    expect(isClaudeSdkInstalling(dir)).toBe(false);
  });

  it("isClaudeSdkInstalling：活 pid 锁为 true", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, ".installing"), String(process.pid), "utf8");
    expect(isClaudeSdkInstalling(dir)).toBe(true);
  });

  it("isClaudeSdkInstalling：死 pid 锁自动清除并返回 false", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, ".installing"), "999999999", "utf8");
    expect(isClaudeSdkInstalling(dir)).toBe(false);
    expect(existsSync(join(dir, ".installing"))).toBe(false);
  });

  it("isClaudeSdkInstalling：损坏锁自动清除并返回 false", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, ".installing"), "abc", "utf8");
    expect(isClaudeSdkInstalling(dir)).toBe(false);
    expect(existsSync(join(dir, ".installing"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 安装流程
// ---------------------------------------------------------------------------

describe("installClaudeSdk", () => {
  it("已装同版本 → 直接 done，不 spawn", async () => {
    const dir = makeTempDir();
    fakeInstallArtifact(dir, CLAUDE_SDK_VERSION);
    const phases: string[] = [];
    await installClaudeSdk({
      dir,
      npmCommand: "definitely-not-exists",
      onProgress: (p) => phases.push(p.phase),
    });
    expect(phases).toEqual(["done"]);
    expect(getClaudeSdkInstalledVersion(dir)).toBe(CLAUDE_SDK_VERSION);
  });

  it("未安装 → fake npm 成功 → done + 锁清除 + 进度序列", async () => {
    const dir = makeTempDir();
    const npmCommand = makeFakeNpmCommand(makeTempDir());
    const phases: string[] = [];
    const messages: string[] = [];
    await installClaudeSdk({
      dir,
      npmCommand,
      onProgress: (p) => {
        phases.push(p.phase);
        messages.push(p.message);
      },
    });
    expect(phases[0]).toBe("detecting");
    expect(phases).toContain("downloading");
    expect(phases[phases.length - 1]).toBe("done");
    expect(isClaudeSdkInstalled(dir)).toBe(true);
    expect(getClaudeSdkInstalledVersion(dir)).toBe(CLAUDE_SDK_VERSION);
    expect(existsSync(join(dir, ".installing"))).toBe(false);
  });

  it("已装不同版本 → 触发重装并成功", async () => {
    const dir = makeTempDir();
    fakeInstallArtifact(dir, "0.1.0");
    const npmCommand = makeFakeNpmCommand(makeTempDir());
    await installClaudeSdk({ dir, npmCommand });
    expect(getClaudeSdkInstalledVersion(dir)).toBe(CLAUDE_SDK_VERSION);
  });

  it("安装失败（fake npm exit 1）→ error + 目录清理 + reject", async () => {
    const dir = makeTempDir();
    const npmCommand = makeFakeNpmCommand(makeTempDir());
    const phases: string[] = [];
    process.env.FAKE_NPM_FAIL = "1";
    try {
      await expect(
        installClaudeSdk({
          dir,
          npmCommand,
          onProgress: (p) => phases.push(p.phase),
        }).then(() => {
          throw new Error("should have rejected");
        }),
      ).rejects.toThrow(/退出码 1/);
    } finally {
      delete process.env.FAKE_NPM_FAIL;
    }
    expect(phases[phases.length - 1]).toBe("error");
    expect(existsSync(dir)).toBe(false);
  });

  it("安装失败（spawn error）→ reject 且不残留锁", async () => {
    const dir = makeTempDir();
    await expect(
      installClaudeSdk({ dir, npmCommand: join(makeTempDir(), "no-such-npm") }),
    ).rejects.toThrow();
    expect(existsSync(dir)).toBe(false);
  });

  it("锁存在（活 pid）→ reject 且不启动安装", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, ".installing"), String(process.pid), "utf8");
    await expect(
      installClaudeSdk({ dir, npmCommand: "definitely-not-exists" }),
    ).rejects.toThrow(/另一个安装任务/);
  });

  it("并发：安装进行中再次调用 → reject", async () => {
    const dir = makeTempDir();
    const npmCommand = makeFakeNpmCommand(makeTempDir());
    process.env.FAKE_NPM_SLEEP = "400";
    try {
      const p1 = installClaudeSdk({
        dir,
        npmCommand,
        expectedVersion: CLAUDE_SDK_VERSION,
      });
      await sleep(80); // 等 installInProgress = true
      await expect(
        installClaudeSdk({ dir, npmCommand }),
      ).rejects.toThrow(/正在安装/);
      await p1;
    } finally {
      delete process.env.FAKE_NPM_SLEEP;
    }
    expect(getClaudeSdkInstalledVersion(dir)).toBe(CLAUDE_SDK_VERSION);
  });

  it("进度 percent 单调且封顶 100", async () => {
    const dir = makeTempDir();
    const npmCommand = makeFakeNpmCommand(makeTempDir());
    const progress: SdkInstallProgress[] = [];
    await installClaudeSdk({ dir, npmCommand, onProgress: (p) => progress.push(p) });
    expect(progress.length).toBeGreaterThan(1);
    for (const p of progress) {
      expect(p.percent).toBeGreaterThanOrEqual(0);
      expect(p.percent).toBeLessThanOrEqual(100);
    }
    expect(progress[progress.length - 1].percent).toBe(100);
  });
});
