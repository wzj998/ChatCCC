import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { searchCodeForTool } from "../file-tools.js";

const dirs: string[] = [];
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "deepccc-scope-"));
  dirs.push(dir);
  for (const name of ["src", ".venv/lib", "node_modules/pkg", ".hidden"]) {
    await mkdir(join(dir, name), { recursive: true });
    await writeFile(join(dir, name, "impl.py"), "class Marker: pass\n");
  }
  return dir;
}
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

it("baseline: explicit dependency files remain readable/searchable", async () => {
  const dir = await fixture();
  const result = await searchCodeForTool(dir, { path: ".venv/lib/impl.py", query: "Marker" });
  expect(result.matches).toHaveLength(1);
});

for (const ripgrepCommands of [undefined, []]) {
  it(`supports project, explicit dependency and expanded search (${ripgrepCommands ? "fallback" : "rg"})`, async () => {
    const dir = await fixture();
    const options = { ripgrepCommands };
    const normal = await searchCodeForTool(dir, { query: "Marker" }, undefined, options);
    expect(normal.matches).toHaveLength(1);
    expect(normal.scope).toBe("project");
    expect(normal.excluded).toContain(".venv");
    expect((await searchCodeForTool(dir, { query:"Marker", glob:"*.py" }, undefined, options)).matches).toHaveLength(1);
    const dependency = await searchCodeForTool(dir, { query: "Marker", path: ".venv" }, undefined, options);
    expect(dependency.matches).toHaveLength(1);
    expect(dependency.scope).toBe("all");
    const expanded = await searchCodeForTool(dir, { query: "Marker", scope: "all" }, undefined, options);
    expect(expanded.matches).toHaveLength(4);
    const limited = await searchCodeForTool(dir, { query: "Marker", scope: "all", maxResults: 1 }, undefined, options);
    expect(limited.truncated).toBe(true);
    const empty = await searchCodeForTool(dir, { query: "not_here" }, undefined, options);
    expect(empty.matches).toEqual([]);
    expect(empty.truncated).toBe(false);
    await expect(searchCodeForTool(dir, { query: "[" }, undefined, options)).rejects.toThrow();
  });
}
