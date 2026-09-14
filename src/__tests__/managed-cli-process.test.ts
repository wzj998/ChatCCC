import { afterEach, describe, expect, it, vi } from "vitest";
const kill = vi.hoisted(() => vi.fn());
vi.mock("../adapters/proc-tree-kill.ts", () => ({ killProcessTree: kill }));
import { ensureCliSessionReleased, ownCliProcess, cliProcessOptions } from "../adapters/managed-cli-process.ts";

afterEach(() => { kill.mockReset(); });
describe("CLI process ownership", () => {
  it.each(["linux", "darwin", "win32"] as const)("uses correct isolation on %s", platform => {
    expect(cliProcessOptions(platform).detached).toBe(platform !== "win32");
  });
  it("coalesces stop calls and retains ownership until cleanup finishes", async () => {
    let finish!: (value: boolean) => void;
    kill.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const owner = ownCliProcess("owned", 321);
    await expect(ensureCliSessionReleased("owned")).rejects.toThrow("仍在执行");
    const first = owner.stop();
    const second = owner.stop();
    let released = false;
    const next = ensureCliSessionReleased("owned").then(() => { released = true; });
    await Promise.resolve();
    expect(released).toBe(false);
    expect(kill).toHaveBeenCalledOnce();
    finish(true);
    await Promise.all([first, second, next]);
    expect(released).toBe(true);
  });
  it("blocks reuse and exposes cleanup failure until a later cleanup succeeds", async () => {
    kill.mockResolvedValue(false);
    const owner = ownCliProcess("failed", 322);
    await expect(owner.stop()).rejects.toThrow("未确认退出");
    await expect(ensureCliSessionReleased("failed")).rejects.toThrow("未确认退出");
    kill.mockResolvedValue(true);
    await ensureCliSessionReleased("failed");
  });
});
