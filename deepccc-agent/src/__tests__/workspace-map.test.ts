import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { buildWorkspaceMap, needsWorkspaceOrientation, rememberProjectFact } from "../workspace-map.js";

const dirs: string[] = [];
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "deepccc-map-")); dirs.push(dir);
  const cwd = join(dir, "project"); const cacheDir = join(dir, "cache");
  await mkdir(join(cwd, "model_core"), { recursive: true });
  await mkdir(join(cwd, ".venv"));
  await writeFile(join(cwd, "model_core/net.py"), "class Policy(nn.Module):\n    pass\n");
  await writeFile(join(cwd, ".venv/noise.py"), "class Dependency: pass\n");
  return { cwd, cacheDir };
}
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

it("maps arbitrary projects with bounded symbol hints and no dependency noise", async () => {
  const {cwd, cacheDir} = await fixture();
  const map = await buildWorkspaceMap(cwd, {query:"Policy", cacheDir});
  expect(map.text).toContain("model_core/net.py");
  expect(map.text).toContain("class Policy");
  expect(map.text).not.toContain("class Dependency");
  expect(map.partial).toBe(false);
  expect((await buildWorkspaceMap(cwd, {cacheDir, maxChars:500})).text.length).toBeLessThanOrEqual(500);
});

it("refreshes same-length edits, added and removed files, including stale evidence", async () => {
  const {cwd, cacheDir} = await fixture();
  await rememberProjectFact(cwd, {fact:"Policy is a network", path:"model_core/net.py", excerpt:"class Policy(nn.Module):"}, cacheDir);
  expect((await buildWorkspaceMap(cwd, {cacheDir})).text).toContain("Policy is a network");
  await rememberProjectFact(cwd, {fact:"Policy subclasses nn.Module; its use still needs verification", path:"model_core/net.py", excerpt:"class Policy(nn.Module):"}, cacheDir);
  const corrected = await buildWorkspaceMap(cwd,{cacheDir});
  expect(corrected.text).not.toContain("Policy is a network");
  expect(corrected.text).toContain("Policy subclasses nn.Module");
  await writeFile(join(cwd,"model_core/net.py"), "class Other(nn.Module):\n    pass\n");
  const changed = await buildWorkspaceMap(cwd, {cacheDir});
  expect(changed.text).toContain("class Other");
  expect(changed.text).not.toContain("Policy is a network");
  expect(changed.invalidatedFacts).toBe(1);
  await rm(join(cwd,"model_core/net.py"));
  await writeFile(join(cwd,"new.ts"), "export function newFeature() {}\n");
  const moved = await buildWorkspaceMap(cwd, {cacheDir});
  expect(moved.text).not.toContain("class Other");
  expect(moved.text).toContain("newFeature");
});

it("rejects invented evidence and supports explicit dependency maps", async () => {
  const {cwd, cacheDir} = await fixture();
  await expect(rememberProjectFact(cwd, {fact:"invented", path:"model_core/net.py", excerpt:"nonexistent"}, cacheDir)).rejects.toThrow("excerpt");
  expect((await buildWorkspaceMap(join(cwd,".venv"), {cacheDir})).text).toContain("Dependency");
  const map = await buildWorkspaceMap(cwd, {cacheDir, maxFiles:1});
  expect(map.partial).toBe(true);
  expect(map.text).toContain("partial");
});

it("does not modify repository files and can operate without a writable cache", async () => {
  const {cwd, cacheDir} = await fixture();
  await writeFile(cacheDir,"not a directory");
  const result = await buildWorkspaceMap(cwd, {cacheDir});
  expect(result.text).toContain("Policy");
  expect(result.warnings.join(" ")).toContain("cache");
  expect(await readFile(join(cwd,"model_core/net.py"),"utf8")).toContain("Policy");
});

it("does not let imports hide definitions and ranks the requested symbol", async () => {
  const {cwd, cacheDir} = await fixture();
  await writeFile(join(cwd,"model_core/net.py"), Array.from({length:40},(_,i)=>`import module${i}`).join("\n") + "\nclass DeepPolicy(nn.Module): pass\n");
  const map = await buildWorkspaceMap(cwd,{cacheDir,query:"DeepPolicy",maxChars:1200});
  expect(map.text).toContain("class DeepPolicy");
  expect(map.displayTruncated).toBe(true);
});

it("bounds navigation to project-related turns, honours abort and workspace boundaries", async () => {
  expect(needsWorkspaceOrientation("[skill] project code [User message]你好")).toBe(false);
  expect(needsWorkspaceOrientation("继续")).toBe(true);
  const {cwd, cacheDir} = await fixture();
  await writeFile(join(cwd,"../outside.py"),"class Outside: pass");
  await expect(rememberProjectFact(cwd,{fact:"outside",path:"../outside.py",excerpt:"class Outside"},cacheDir)).rejects.toThrow("within workspace");
  const controller = new AbortController(); controller.abort();
  await expect(buildWorkspaceMap(cwd,{cacheDir,signal:controller.signal})).rejects.toThrow("aborted");
});
