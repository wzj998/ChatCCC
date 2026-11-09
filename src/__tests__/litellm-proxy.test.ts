import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

async function runProxy(args: string[], upstream?: string) {
  const env = { ...process.env };
  // Never inherit the user's real upstream, port or logging options in tests.
  for (const key of Object.keys(env)) {
    if (key.startsWith("CHATCCC_LITELLM_PROXY_")) delete env[key];
  }
  if (upstream !== undefined) env.CHATCCC_LITELLM_PROXY_UPSTREAM = upstream;
  try {
    const result = await execFileAsync(process.execPath, [
      "--import", "tsx", "src/litellm-proxy.ts", ...args,
    ], { cwd: process.cwd(), env, windowsHide: true, timeout: 10_000 });
    return { code: 0, ...result };
  } catch (error) {
    const result = error as { code?: number; stdout?: string; stderr?: string };
    return { code: result.code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
}

describe("LiteLLM proxy configuration", () => {
  it("shows help without an upstream and without starting a server", async () => {
    const result = await runProxy(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--upstream <url>");
    expect(result.stdout).toContain("CHATCCC_LITELLM_PROXY_UPSTREAM");
    expect(result.stdout).not.toContain("[litellm-proxy] listening");
  }, 15_000);

  it("keeps CLI upstream precedence over the environment", async () => {
    // Port zero guarantees no server starts even if upstream resolution regresses.
    const result = await runProxy(["--upstream", "https://api.example.com", "--port", "0"], "not-a-url");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Invalid port: 0");
  }, 15_000);

  it("accepts an explicitly configured environment upstream", async () => {
    const result = await runProxy(["--port", "0"], "https://api.example.com");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Invalid port: 0");
  }, 15_000);

  it.each([undefined, "", "   "])("rejects a missing or blank upstream (%s) before starting", async upstream => {
    const result = await runProxy(["--port", "0"], upstream);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("set --upstream or CHATCCC_LITELLM_PROXY_UPSTREAM");
    expect(result.stdout).not.toContain("[litellm-proxy] listening");
  }, 15_000);

  it("rejects non-HTTP upstreams before starting", async () => {
    const result = await runProxy(["--port", "0"], "file:///example");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Upstream must use http:// or https://");
  }, 15_000);
});
