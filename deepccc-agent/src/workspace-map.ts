import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { skipProjectEntry } from "./workspace-policy.js";

const MAX_FILE_BYTES = 128 * 1024;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const CACHE_VERSION = 2;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".py", ".go", ".rs", ".java", ".cs", ".c", ".h", ".cpp", ".rb", ".php", ".md", ".json", ".toml"]);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

interface MapEntry { path: string; hash: string; hints: string[] }
interface ProjectFact { fact: string; path: string; excerpt: string; hash: string; checkedAt: string }
export interface ProjectFactInput { fact: string; path: string; excerpt: string }
export interface WorkspaceMapOptions {
  query?: string;
  maxChars?: number;
  /** Internal test/cache overrides; not exposed to the model. */
  cacheDir?: string;
  maxFiles?: number;
  signal?: AbortSignal;
}
export interface WorkspaceMapResult {
  root: string; text: string; partial: boolean; indexedFiles: number;
  invalidatedFacts: number; warnings: string[]; displayTruncated: boolean;
}

async function cacheRoot(cwd: string, base?: string) {
  const root = await realpath(cwd);
  return { root, directory: join(base ?? join(homedir(), ".deepccc", "workspace-index"), hash(process.platform === "win32" ? root.toLowerCase() : root)) };
}
async function atomicJson(path: string, value: unknown) {
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}
async function boundedText(path: string): Promise<string | null> {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    const {bytesRead} = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_FILE_BYTES || bytes.subarray(0, bytesRead).includes(0)) return null;
    return bytes.subarray(0, bytesRead).toString("utf8");
  } finally { await file.close(); }
}

/** Lightweight lexical hints, NOT a compiler symbol table or a proven call graph. */
function extractHints(path: string, text: string): string[] {
  if (path.endsWith("package.json")) {
    try {
      const pkg = JSON.parse(text);
      return ["main", "module", "types", "bin"].filter(key => typeof pkg[key] === "string")
        .map(key => `${key}: ${String(pkg[key]).slice(0, 180)}`)
        .concat(Object.keys(pkg.scripts ?? {}).slice(0, 10).map(key => `script: ${key}`));
    } catch { return []; }
  }
  // Do not index arbitrary JSON/TOML values (credentials/configuration).
  if ([".json", ".toml"].includes(extname(path))) return [];
  return text.split(/\r?\n/).flatMap((line, i) => {
    if (/^\s*(?:export\s+(?:default\s+)?)?(?:(?:public|private|abstract|async)\s+)*(?:class|interface|type|enum|function|def|struct|trait|fn|func|import|from|use)\s+[\w$({*]/.test(line)
      || (path.endsWith(".md") && /^#{1,3}\s/.test(line))) {
      return [`${i + 1}: ${line.trim().slice(0, 180)}`];
    }
    return [];
  }).sort((a,b) => Number(/:\s*(?:from|import|use|require)\b/.test(a)) - Number(/:\s*(?:from|import|use|require)\b/.test(b))).slice(0, 64);
}

/** Always re-enumerate and hash bounded source files: branch switches and same-size edits invalidate hints. */
export async function buildWorkspaceMap(cwd: string, options: WorkspaceMapOptions = {}): Promise<WorkspaceMapResult> {
  const {root, directory} = await cacheRoot(cwd, options.cacheDir);
  const warnings: string[] = [];
  const old = new Map<string, MapEntry>();
  try {
    const cached = JSON.parse(await readFile(join(directory,"map.json"), "utf8"));
    if (cached.version === CACHE_VERSION && Array.isArray(cached.entries)) {
      for (const item of cached.entries) if (typeof item?.path === "string" && typeof item.hash === "string" && Array.isArray(item.hints) && item.hints.every((h: unknown) => typeof h === "string")) old.set(item.path, item);
    }
  } catch { /* Missing/corrupt caches are disposable. */ }
  const entries: MapEntry[] = [];
  const queue = [root];
  let partial = false;
  let visited = 0;
  let bytes = 0;
  const deadline = Date.now() + 2000;
  const maxFiles = Math.max(1, Math.min(options.maxFiles ?? 1500, 5000));
  while (queue.length) {
    if (options.signal?.aborted) throw new Error("workspace map aborted");
    if (Date.now() > deadline || visited >= maxFiles || bytes >= MAX_SCAN_BYTES) { partial = true; break; }
    const dir = queue.shift()!;
    let children;
    try { children = await readdir(dir, {withFileTypes:true}); }
    catch { partial = true; if (warnings.length < 10) warnings.push(`Unreadable directory: ${relative(root, dir)}`); continue; }
    children.sort((a,b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (options.signal?.aborted) throw new Error("workspace map aborted");
      if (visited >= maxFiles || Date.now() > deadline || bytes >= MAX_SCAN_BYTES) { partial = true; break; }
      if (skipProjectEntry(child.name) || child.isSymbolicLink()) continue;
      visited++;
      const path = join(dir, child.name);
      if (child.isDirectory()) { queue.push(path); continue; }
      const name = relative(root,path).replace(/\\/g,"/");
      if (!child.isFile()) continue;
      if (!SOURCE_EXTENSIONS.has(extname(child.name))) { entries.push({path:name, hash:"", hints:[]}); continue; }
      try {
        const text = await boundedText(path);
        if (text === null) { entries.push({path:name, hash:"", hints:["content not indexed: binary or oversized"]}); continue; }
        bytes += Buffer.byteLength(text);
        const digest = hash(text);
        const previous = old.get(name);
        entries.push({path:name, hash:digest, hints:previous?.hash === digest ? previous.hints : extractHints(name,text)});
      } catch { partial = true; if (warnings.length < 10) warnings.push(`Unreadable file: ${name}`); }
    }
  }
  const facts: ProjectFact[] = [];
  let invalidatedFacts = 0;
  try {
    const files = (await readdir(join(directory,"facts"))).filter(f=>f.endsWith(".json"));
    const dated = await Promise.all(files.map(async file => ({file, time:(await stat(join(directory,"facts",file))).mtimeMs})));
    dated.sort((a,b)=>b.time-a.time || a.file.localeCompare(b.file));
    if (files.length > 20) warnings.push("Only the most recent 20 evidence notes were considered; use source searches for additional evidence.");
    for (const {file} of dated.slice(0,20)) {
      if (options.signal?.aborted) throw new Error("workspace map aborted");
      try {
        const fact = JSON.parse(await readFile(join(directory,"facts",file),"utf8")) as ProjectFact;
        if (typeof fact.path !== "string" || typeof fact.fact !== "string" || typeof fact.excerpt !== "string") throw new Error("invalid fact");
        const path = await confinedPath(root, fact.path);
        const text = await boundedText(path);
        if (text !== null && hash(text) === fact.hash && text.includes(fact.excerpt)) facts.push(fact);
        else invalidatedFacts++;
      } catch { invalidatedFacts++; }
    }
  } catch { if (options.signal?.aborted) throw new Error("workspace map aborted"); /* No saved facts. */ }
  try {
    await mkdir(directory,{recursive:true});
    await atomicJson(join(directory,"map.json"),{version:CACHE_VERSION, root, entries});
  } catch { warnings.push("Workspace cache could not be written; using live results."); }

  const terms = (options.query ?? "").toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  const score = (entry: MapEntry) => {
    const text = `${entry.path} ${entry.hints.join(" ")}`.toLowerCase();
    return terms.reduce((n,t)=> n + (text.includes(t) ? 10 : 0),0) + (/^(?:readme|agents|claude|package\.json|pyproject|cargo|go\.mod)/i.test(entry.path) ? 3 : 0) + (entry.hints.some(h=> /\b(?:class|interface|function|def|struct|fn|func)\b/.test(h)) ? 2 : 0);
  };
  entries.sort((a,b)=>score(b)-score(a)||a.path.localeCompare(b.path));
  const limit = Math.max(500,Math.min(options.maxChars ?? 6000,16000));
  let text = `[Workspace map: ${root}]\nNavigation only; lexical hints are not verified implementation facts. Scan: ${partial ? "partial" : "finished within default scope"}; ${entries.length} files. Dependencies/hidden entries are omitted by default; use workspace_map(path) or search_code(scope=all) when needed. Git ignore files are not interpreted by this map.\n`;
  let displayTruncated = false;
  for (const fact of facts) {
    const line = `Evidence note (agent interpretation, verify before decisions): ${fact.fact.slice(0,600)} — ${fact.path}, sha256=${fact.hash}, recorded=${fact.checkedAt}\nExcerpt: ${fact.excerpt.slice(0,400)}\n`;
    if (text.length + line.length > limit / 2) { displayTruncated = true; break; }
    text += line;
  }
  for (const entry of entries) {
    const relevantHints = [...entry.hints].sort((a,b) => terms.filter(t=>b.toLowerCase().includes(t)).length - terms.filter(t=>a.toLowerCase().includes(t)).length);
    const line = `${entry.path}\n${relevantHints.slice(0,4).join("\n").slice(0,500)}\n`;
    if (entry.hints.length > 4) displayTruncated = true;
    if (text.length + line.length > limit - 100) { displayTruncated = true; continue; }
    text += line;
  }
  if (displayTruncated) text += "[Map display abbreviated; query a specific topic/path and read source for more.]\n";
  return {root, text:text.slice(0,limit), partial, indexedFiles:entries.length, invalidatedFacts, warnings, displayTruncated};
}

async function confinedPath(root: string, path: string): Promise<string> {
  const target = await realpath(resolve(root,path));
  const rel = relative(root,target);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) throw new Error("evidence path must be within workspace");
  return target;
}
/** Persist an interpretation only with a matching source excerpt; never promote it to a system rule. */
export async function rememberProjectFact(cwd: string, input: ProjectFactInput, cacheDir?: string) {
  if (!input.fact?.trim() || input.fact.length > 600 || !input.excerpt?.trim() || input.excerpt.length > 1000) throw new Error("fact/excerpt must be nonempty and bounded");
  const {root,directory} = await cacheRoot(cwd,cacheDir);
  const path = await confinedPath(root,input.path);
  const text = await boundedText(path);
  if (text === null || !text.includes(input.excerpt)) throw new Error("source excerpt does not match current readable file");
  const note: ProjectFact = {fact:input.fact.trim(),path:relative(root,path).replace(/\\/g,"/"),excerpt:input.excerpt,hash:hash(text),checkedAt:new Date().toISOString()};
  await mkdir(join(directory,"facts"),{recursive:true});
  // Correcting an interpretation for the same evidence replaces the old note.
  const id = hash(`${note.path}\n${note.excerpt}`);
  await atomicJson(join(directory,"facts",`${id}.json`),note);
  return {saved:true, ...note, notice:"Source excerpt verified; interpretation is not independently proven. Revalidated on each workspace map."};
}

export function needsWorkspaceOrientation(message: string): boolean {
  const user = message.split("[User message]").pop() ?? message;
  return /项目|代码|仓库|实现|架构|功能|修复|编译|测试|模块|继续|挖.*因子|\b(?:repo|project|code|implement|architecture|feature|fix|build|test|module|continue)\b/i.test(user);
}
