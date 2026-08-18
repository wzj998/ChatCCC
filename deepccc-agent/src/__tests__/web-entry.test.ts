import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { isLegacyCliInvocation, parseWebEntryArgs } from "../web-entry.js";

describe("DeepCCC Web-first entrypoints", () => {
  it("routes bare and Web-specific invocations to the Web server", () => {
    expect(isLegacyCliInvocation([])).toBe(false);
    expect(isLegacyCliInvocation(["web"])).toBe(false);
    expect(isLegacyCliInvocation(["--reuse-existing"])).toBe(false);
    expect(parseWebEntryArgs(["web", "--reuse-existing", "--port", "28081", "--no-open"]))
      .toEqual({ reuseExisting: true, port: 28081, openBrowser: false });
  });

  it("keeps old CLI flags compatible while exposing the deepccc-cli bin", () => {
    expect(isLegacyCliInvocation(["--stream-json", "--prompt", "hello"])).toBe(true);
    expect(isLegacyCliInvocation(["--resume"])).toBe(true);
    expect(isLegacyCliInvocation(["skill", "create", "demo"])).toBe(true);
    const nested = join(process.cwd(), "deepccc-agent", "package.json");
    const pkg = JSON.parse(readFileSync(existsSync(nested) ? nested : join(process.cwd(), "package.json"), "utf8"));
    expect(pkg.bin).toMatchObject({ deepccc: "bin/deepccc.mjs", "deepccc-cli": "bin/deepccc-cli.mjs" });
    expect(pkg.scripts).toMatchObject({ dev: "tsx src/web-entry.ts", "dev:cli": "tsx src/cli.ts" });
  });
});
