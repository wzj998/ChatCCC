import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const CREATE_APP_SKILL_DIRS = [
  ".agents/skills/create-chatccc-feishu-app/",
  ".claude/skills/create-chatccc-feishu-app/",
  ".cursor/skills/create-chatccc-feishu-app/",
];

describe("npm package files", () => {
  it("ships compiled runtime files without TypeScript runtime dependencies", () => {
    const root = process.cwd();
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      main?: string;
      files?: string[];
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(packageJson.main).toBe("./dist/src/index.js");
    expect(packageJson.files).toContain("dist/");
    expect(packageJson.dependencies).not.toHaveProperty("tsx");
    expect(packageJson.dependencies).not.toHaveProperty("esbuild");
    expect(packageJson.devDependencies).toHaveProperty("tsx");
  });

  it("ships the Feishu app creation skill for every supported agent", () => {
    const root = process.cwd();
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      files?: string[];
    };

    for (const skillDir of CREATE_APP_SKILL_DIRS) {
      expect(packageJson.files).toContain(skillDir);
      expect(existsSync(join(root, skillDir, "SKILL.md"))).toBe(true);
    }
  });
});
