import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

import { jsonSchema, tool, type ToolSet } from "ai";

import { isDangerousCommand, type PermissionGate, type PermissionRequest } from "./permissions.js";
import { killProcessTree } from "./proc-tree-kill.js";
import {
  searchBuiltinSessions,
  type SessionSearchInput,
  type SessionSearchOutput,
} from "./session-search.js";
import {
  webFetchForTool,
  webSearchForTool,
  type WebFetchInput,
  type WebFetchOutput,
  type WebSearchInput,
  type WebSearchOutput,
} from "./web-tools.js";

const MAX_READ_BYTES = 1024 * 1024;
const MAX_LIST_ENTRIES = 200;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_BYTES = 256 * 1024;
const MAX_EDIT_BYTES = 2 * 1024 * 1024;
const MAX_CREATE_BYTES = 2 * 1024 * 1024;
const MAX_PATCH_BYTES = 512 * 1024;
const SEARCH_TIMEOUT_MS = 15_000;
const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_TIMEOUT_MS = 900_000;
const requireFromHere = createRequire(import.meta.url);
const FALLBACK_SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

export interface ReadFileInput {
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface ReadFileOutput {
  path: string;
  size: number;
  sha256: string;
  isBinary: boolean;
  truncated: boolean;
  startLine?: number;
  endLine?: number;
  totalLines?: number;
  content: string;
}

export interface ListDirInput {
  path?: string;
}

export interface ListDirEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size?: number;
}

export interface ListDirOutput {
  path: string;
  entries: ListDirEntry[];
  truncated: boolean;
}

export interface SearchCodeInput {
  query: string;
  path?: string;
  glob?: string;
  maxResults?: number;
}

export interface SearchCodeMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface SearchCodeOutput {
  query: string;
  path: string;
  glob?: string;
  matches: SearchCodeMatch[];
  truncated: boolean;
}

/** @internal Allows tests to force the dependency-free fallback path. */
export interface SearchCodeRuntimeOptions {
  ripgrepCommands?: readonly string[];
}

export interface RunCommandInput {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface RunCommandOutput {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

export interface FileEdit {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export interface EditFileInput {
  path: string;
  expectedSha256?: string;
  edits: FileEdit[];
}

export interface FileWriteOutput {
  path: string;
  beforeSha256?: string;
  afterSha256?: string;
  bytesWritten?: number;
  changed: boolean;
}

export interface EditFileOutput extends FileWriteOutput {
  editsApplied: number;
}

export interface CreateFileInput {
  path: string;
  content: string;
  overwrite?: boolean;
  expectedSha256?: string;
}

export interface DeleteFileInput {
  path: string;
  expectedSha256?: string;
}

export interface DeleteFileOutput {
  path: string;
  beforeSha256: string;
  deleted: true;
}

export interface MoveFileInput {
  sourcePath: string;
  destinationPath: string;
  overwrite?: boolean;
  expectedSourceSha256?: string;
  expectedDestinationSha256?: string;
}

export interface MoveFileOutput {
  sourcePath: string;
  destinationPath: string;
  sourceSha256: string;
  overwrittenDestinationSha256?: string;
  moved: true;
}

export interface ApplyPatchInput {
  patch: string;
  expectedSha256ByPath?: Record<string, string>;
}

export interface ApplyPatchFileChange {
  path: string;
  action: "create" | "edit" | "delete";
  beforeSha256?: string;
  afterSha256?: string;
  bytesWritten?: number;
}

export interface ApplyPatchOutput {
  changedFiles: ApplyPatchFileChange[];
}

/**
 * 把 `~` / `~/x`（含反斜杠 `~\\x`）展开为用户主目录绝对路径。
 * `~user/x` 形式不展开（Node 无内置支持），保持原样交给后续解析。
 * 供路径工具共用：技能索引里 `~/...` 路径可直接传给 read_file 等工具。
 */
export function expandHomePath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function resolveToolPath(cwd: string, value: string | undefined): string {
  const raw = value?.trim();
  if (!raw) return resolve(cwd);
  const expanded = expandHomePath(raw);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function toPositiveInt(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) return undefined;
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : undefined;
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  return sample.includes(0);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function sha256(buffer: Buffer | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function assertExpectedSha256(path: string, actual: string, expected: string | undefined): void {
  if (expected && expected !== actual) {
    throw new Error(`SHA-256 mismatch for ${path}: expected ${expected}, got ${actual}`);
  }
}

function assertTextSize(path: string, text: string, maxBytes: number): void {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    throw new Error(`Content for ${path} is too large: ${bytes} bytes, max ${maxBytes}`);
  }
}

async function readEditableTextFile(path: string): Promise<{ text: string; buffer: Buffer; sha: string }> {
  const info = await stat(path);
  if (info.isDirectory()) {
    throw new Error(`Path is a directory: ${path}`);
  }
  if (info.size > MAX_EDIT_BYTES) {
    throw new Error(`File is too large to edit: ${path} (${info.size} bytes, max ${MAX_EDIT_BYTES})`);
  }

  const buffer = await readFile(path);
  if (isBinaryBuffer(buffer)) {
    throw new Error(`Refusing to edit binary file: ${path}`);
  }

  return {
    text: buffer.toString("utf8"),
    buffer,
    sha: sha256(buffer),
  };
}

async function atomicWriteTextFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = resolve(
    dirname(path),
    `.chatccc-${basename(path)}-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    await writeFile(tempPath, text, "utf8");
    await rename(tempPath, path);
  } catch (err) {
    try {
      await unlink(tempPath);
    } catch {
      // Best-effort cleanup.
    }
    throw err;
  }
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    const found = text.indexOf(needle, index);
    if (found === -1) return count;
    count++;
    index = found + needle.length;
  }
}

function replaceAllLiteral(text: string, oldText: string, newText: string): string {
  return text.split(oldText).join(newText);
}

function detectEol(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function normalizeCommandTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_COMMAND_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(value), 1_000), MAX_COMMAND_TIMEOUT_MS);
}

function appendLimitedOutput(
  target: { chunks: string[]; bytes: number; truncated: boolean },
  chunk: Buffer,
): void {
  const remaining = MAX_COMMAND_OUTPUT_BYTES - target.bytes;
  if (remaining <= 0) {
    target.truncated = true;
    return;
  }

  if (chunk.byteLength <= remaining) {
    target.chunks.push(chunk.toString("utf8"));
    target.bytes += chunk.byteLength;
    return;
  }

  target.chunks.push(chunk.subarray(0, remaining).toString("utf8"));
  target.bytes += remaining;
  target.truncated = true;
}

function splitPatchPath(value: string): string | null {
  const token = value.trim().split(/\s+/)[0];
  if (!token || token === "/dev/null") return null;
  if ((token.startsWith("a/") || token.startsWith("b/")) && token.length > 2) {
    return token.slice(2);
  }
  return token;
}

interface ParsedPatchLine {
  kind: "context" | "add" | "remove";
  text: string;
}

interface ParsedPatchHunk {
  oldStart: number;
  lines: ParsedPatchLine[];
}

interface ParsedPatchFile {
  oldPath: string | null;
  newPath: string | null;
  hunks: ParsedPatchHunk[];
}

function parseHunkHeader(line: string): number {
  const match = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
  if (!match) {
    throw new Error(`Invalid hunk header: ${line}`);
  }
  return Number(match[1]);
}

function parseUnifiedPatch(patch: string): ParsedPatchFile[] {
  assertTextSize("patch", patch, MAX_PATCH_BYTES);
  const normalizedPatch = patch.replace(/\r\n/g, "\n");
  const lines = (normalizedPatch.endsWith("\n") ? normalizedPatch.slice(0, -1) : normalizedPatch).split("\n");
  const files: ParsedPatchFile[] = [];
  let current: ParsedPatchFile | null = null;
  let currentHunk: ParsedPatchHunk | null = null;

  const finishFile = () => {
    if (!current) return;
    if (!current.oldPath && !current.newPath) {
      current = null;
      currentHunk = null;
      return;
    }
    files.push(current);
    current = null;
    currentHunk = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      finishFile();
      current = { oldPath: null, newPath: null, hunks: [] };
      continue;
    }

    if (line.startsWith("--- ")) {
      if (current?.hunks.length) finishFile();
      current ??= { oldPath: null, newPath: null, hunks: [] };
      current.oldPath = splitPatchPath(line.slice(4));
      currentHunk = null;
      continue;
    }

    if (line.startsWith("+++ ")) {
      current ??= { oldPath: null, newPath: null, hunks: [] };
      current.newPath = splitPatchPath(line.slice(4));
      currentHunk = null;
      continue;
    }

    if (line.startsWith("@@ ")) {
      if (!current) throw new Error(`Hunk without file header: ${line}`);
      currentHunk = { oldStart: parseHunkHeader(line), lines: [] };
      current.hunks.push(currentHunk);
      continue;
    }

    if (line === "\\ No newline at end of file") continue;
    if (!currentHunk) continue;

    if (line.startsWith(" ")) {
      currentHunk.lines.push({ kind: "context", text: line.slice(1) });
    } else if (line.startsWith("+")) {
      currentHunk.lines.push({ kind: "add", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({ kind: "remove", text: line.slice(1) });
    } else {
      throw new Error(`Invalid patch line: ${line}`);
    }
  }

  finishFile();
  if (files.length === 0) throw new Error("Patch does not contain any file changes");
  return files;
}

function splitContentLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.replace(/\r\n/g, "\n").split("\n");
}

function applyParsedHunks(path: string, text: string, hunks: ParsedPatchHunk[]): string {
  const eol = detectEol(text);
  const original = splitContentLines(text);
  const output: string[] = [];
  let oldIndex = 0;

  for (const hunk of hunks) {
    const targetIndex = Math.max(0, hunk.oldStart - 1);
    if (targetIndex < oldIndex) {
      throw new Error(`Overlapping hunk in patch for ${path}`);
    }
    output.push(...original.slice(oldIndex, targetIndex));
    oldIndex = targetIndex;

    for (const line of hunk.lines) {
      if (line.kind === "add") {
        output.push(line.text);
        continue;
      }

      if (oldIndex >= original.length || original[oldIndex] !== line.text) {
        throw new Error(`Patch context mismatch in ${path} near line ${oldIndex + 1}`);
      }

      if (line.kind === "context") {
        output.push(original[oldIndex]);
      }
      oldIndex++;
    }
  }

  output.push(...original.slice(oldIndex));
  return output.join(eol);
}

export async function readFileForTool(cwd: string, input: ReadFileInput): Promise<ReadFileOutput> {
  const filePath = resolveToolPath(cwd, input.path);
  const info = await stat(filePath);
  if (info.isDirectory()) {
    throw new Error(`Path is a directory: ${filePath}`);
  }

  const bytesToRead = Math.min(info.size, MAX_READ_BYTES);
  const buffer = Buffer.alloc(bytesToRead);
  const handle = await open(filePath, "r");
  try {
    await handle.read(buffer, 0, bytesToRead, 0);
  } finally {
    await handle.close();
  }
  const fileSha256 = await sha256File(filePath);
  const isBinary = isBinaryBuffer(buffer);
  if (isBinary) {
    return {
      path: filePath,
      size: info.size,
      sha256: fileSha256,
      isBinary: true,
      truncated: info.size > bytesToRead,
      content: "",
    };
  }

  const text = buffer.toString("utf8");
  const lines = text.split(/\r?\n/);
  const totalLines = lines.length;
  const startLine = toPositiveInt(input.startLine) ?? 1;
  const endLine = toPositiveInt(input.endLine) ?? totalLines;
  const normalizedEnd = Math.max(startLine, Math.min(endLine, totalLines));
  const content = lines.slice(startLine - 1, normalizedEnd).join("\n");

  return {
    path: filePath,
    size: info.size,
    sha256: fileSha256,
    isBinary: false,
    truncated: info.size > bytesToRead || normalizedEnd < totalLines || startLine > 1,
    startLine,
    endLine: normalizedEnd,
    totalLines,
    content,
  };
}

export async function listDirForTool(cwd: string, input: ListDirInput = {}): Promise<ListDirOutput> {
  const dirPath = resolveToolPath(cwd, input.path);
  const entries = await readdir(dirPath, { withFileTypes: true });
  const selected = entries.slice(0, MAX_LIST_ENTRIES);
  const result: ListDirEntry[] = [];

  for (const entry of selected) {
    const entryPath = resolve(dirPath, entry.name);
    let size: number | undefined;
    if (entry.isFile()) {
      try {
        size = (await stat(entryPath)).size;
      } catch {
        size = undefined;
      }
    }
    result.push({
      name: entry.name,
      path: entryPath,
      type: entry.isDirectory()
        ? "directory"
        : entry.isFile()
          ? "file"
          : entry.isSymbolicLink()
            ? "symlink"
            : "other",
      ...(size !== undefined ? { size } : {}),
    });
  }

  return {
    path: dirPath,
    entries: result,
    truncated: entries.length > selected.length,
  };
}

function parseRgLine(line: string): SearchCodeMatch | null {
  const match = /^(.*?):(\d+):(\d+):(.*)$/.exec(line);
  if (!match) return null;
  return {
    path: match[1],
    line: Number(match[2]),
    column: Number(match[3]),
    text: match[4],
  };
}

interface RipgrepOutput {
  stdout: string;
  stderr: string;
  truncated: boolean;
}

function resolveBundledRipgrepPath(): string | undefined {
  try {
    const bundled = requireFromHere("@vscode/ripgrep") as { rgPath?: unknown };
    return typeof bundled.rgPath === "string" && bundled.rgPath.trim()
      ? bundled.rgPath
      : undefined;
  } catch {
    // Unsupported platforms or damaged optional platform packages must not
    // prevent ChatCCC itself from starting; system rg / Node fallback remain.
    return undefined;
  }
}

function defaultRipgrepCommands(): string[] {
  const bundled = resolveBundledRipgrepPath();
  return [...new Set([bundled, "rg"].filter((value): value is string => !!value))];
}

function isUnavailableExecutableError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM";
}

async function runRipgrep(
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<RipgrepOutput> {
  return new Promise<RipgrepOutput>((resolvePromise, reject) => {
    let settled = false;
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    };
    const rejectOnce = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const timeout = setTimeout(() => {
      child.kill();
      rejectOnce(new Error(`search_code timed out after ${SEARCH_TIMEOUT_MS}ms`));
    }, SEARCH_TIMEOUT_MS);
    const abort = () => {
      child.kill();
      rejectOnce(new Error("search_code aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length >= MAX_SEARCH_BYTES) {
        truncated = true;
        return;
      }
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_SEARCH_BYTES) {
        stdout = stdout.slice(0, MAX_SEARCH_BYTES);
        truncated = true;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => rejectOnce(err));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code !== 0 && code !== 1) {
        reject(new Error(stderr.trim() || `rg exited with code ${code}`));
        return;
      }
      resolvePromise({ stdout, stderr, truncated });
    });
  });
}

function expandGlobBraces(pattern: string): string[] {
  const openIndex = pattern.indexOf("{");
  if (openIndex < 0) return [pattern];
  const closeIndex = pattern.indexOf("}", openIndex + 1);
  if (closeIndex < 0) return [pattern];
  const alternatives = pattern.slice(openIndex + 1, closeIndex).split(",");
  if (alternatives.length < 2) return [pattern];
  return alternatives.flatMap((alternative) => expandGlobBraces(
    pattern.slice(0, openIndex) + alternative + pattern.slice(closeIndex + 1),
  ));
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function createGlobMatchers(glob: string | undefined): Array<{ regex: RegExp; basenameOnly: boolean }> {
  if (!glob?.trim()) return [];
  return expandGlobBraces(glob.trim().replaceAll("\\", "/")).map((pattern) => ({
    regex: globToRegExp(pattern),
    basenameOnly: !pattern.includes("/"),
  }));
}

function matchesFallbackGlob(
  filePath: string,
  searchRoot: string,
  matchers: Array<{ regex: RegExp; basenameOnly: boolean }>,
): boolean {
  if (matchers.length === 0) return true;
  const relativePath = relative(searchRoot, filePath).split(sep).join("/");
  return matchers.some(({ regex, basenameOnly }) => regex.test(
    basenameOnly ? basename(filePath) : relativePath,
  ));
}

async function searchCodeWithNode(
  query: string,
  searchPath: string,
  glob: string | undefined,
  maxResults: number,
  signal?: AbortSignal,
): Promise<{ matches: SearchCodeMatch[]; truncated: boolean }> {
  let queryRegex: RegExp;
  try {
    queryRegex = new RegExp(query);
  } catch (err) {
    throw new Error(`invalid search regex: ${(err as Error).message}`);
  }

  const startedAt = Date.now();
  const matches: SearchCodeMatch[] = [];
  const rootInfo = await stat(searchPath);
  const searchRoot = rootInfo.isDirectory() ? searchPath : dirname(searchPath);
  const globMatchers = createGlobMatchers(glob);
  let truncated = false;
  let outputBytes = 0;

  const ensureActive = () => {
    if (signal?.aborted) throw new Error("search_code aborted");
    if (Date.now() - startedAt >= SEARCH_TIMEOUT_MS) {
      throw new Error(`search_code timed out after ${SEARCH_TIMEOUT_MS}ms`);
    }
  };

  const searchFile = async (filePath: string) => {
    if (!matchesFallbackGlob(filePath, searchRoot, globMatchers)) return;
    ensureActive();
    const input = createReadStream(filePath, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let lineNumber = 0;
    try {
      for await (const line of lines) {
        ensureActive();
        lineNumber += 1;
        if (line.includes("\0")) break;
        const match = queryRegex.exec(line);
        queryRegex.lastIndex = 0;
        if (!match) continue;
        const lineBytes = Buffer.byteLength(line, "utf8");
        if (outputBytes + lineBytes > MAX_SEARCH_BYTES) {
          truncated = true;
          break;
        }
        outputBytes += lineBytes;
        matches.push({
          path: filePath,
          line: lineNumber,
          column: match.index + 1,
          text: line,
        });
        if (matches.length >= maxResults) {
          truncated = true;
          break;
        }
      }
    } catch (err) {
      if (signal?.aborted) throw new Error("search_code aborted");
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "EACCES" && code !== "EPERM" && code !== "ENOENT") throw err;
    } finally {
      lines.close();
      input.destroy();
    }
  };

  const visit = async (currentPath: string): Promise<void> => {
    ensureActive();
    if (truncated) return;
    let info;
    try {
      info = currentPath === searchPath ? rootInfo : await stat(currentPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "EACCES" || code === "EPERM" || code === "ENOENT") return;
      throw err;
    }
    if (info.isFile()) {
      await searchFile(currentPath);
      return;
    }
    if (!info.isDirectory()) return;

    let entries;
    try {
      entries = await readdir(currentPath, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "EACCES" || code === "EPERM" || code === "ENOENT") return;
      throw err;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (truncated) break;
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory() && FALLBACK_SKIPPED_DIRECTORIES.has(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;
      await visit(resolve(currentPath, entry.name));
    }
  };

  await visit(searchPath);
  return { matches, truncated };
}

export async function searchCodeForTool(
  cwd: string,
  input: SearchCodeInput,
  signal?: AbortSignal,
  runtimeOptions: SearchCodeRuntimeOptions = {},
): Promise<SearchCodeOutput> {
  const query = input.query?.trim();
  if (!query) throw new Error("query is required");
  if (signal?.aborted) throw new Error("search_code aborted");

  const searchPath = resolveToolPath(cwd, input.path);
  const maxResults = Math.min(toPositiveInt(input.maxResults) ?? 50, MAX_SEARCH_RESULTS);
  const args = [
    "--line-number",
    "--column",
    "--no-heading",
    "--color",
    "never",
    "--max-count",
    String(maxResults),
  ];
  if (input.glob?.trim()) {
    args.push("--glob", input.glob.trim());
  }
  args.push("--", query, searchPath);

  const commands = runtimeOptions.ripgrepCommands ?? defaultRipgrepCommands();
  let output: RipgrepOutput | undefined;
  for (const command of commands) {
    try {
      output = await runRipgrep(command, args, cwd, signal);
      break;
    } catch (err) {
      if (!isUnavailableExecutableError(err)) throw err;
    }
  }

  const fallback = output
    ? undefined
    : await searchCodeWithNode(query, searchPath, input.glob?.trim(), maxResults, signal);
  const matches = output
    ? output.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map(parseRgLine)
      .filter((match): match is SearchCodeMatch => !!match)
      .slice(0, maxResults)
    : fallback!.matches;

  return {
    query,
    path: searchPath,
    ...(input.glob?.trim() ? { glob: input.glob.trim() } : {}),
    matches,
    truncated: output
      ? output.truncated || matches.length >= maxResults
      : fallback!.truncated,
  };
}

export async function runCommandForTool(
  cwd: string,
  input: RunCommandInput,
  abortSignal?: AbortSignal,
): Promise<RunCommandOutput> {
  const command = input.command?.trim();
  if (!command) throw new Error("command is required");

  const commandCwd = resolveToolPath(cwd, input.cwd);
  const cwdInfo = await stat(commandCwd);
  if (!cwdInfo.isDirectory()) {
    throw new Error(`cwd is not a directory: ${commandCwd}`);
  }

  const timeoutMs = normalizeCommandTimeoutMs(input.timeoutMs);
  const startedAt = Date.now();
  const stdout = { chunks: [] as string[], bytes: 0, truncated: false };
  const stderr = { chunks: [] as string[], bytes: 0, truncated: false };

  return new Promise<RunCommandOutput>((resolvePromise, reject) => {
    let settled = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout;
    let fallbackTimer: NodeJS.Timeout | undefined;

    const child = spawn(command, {
      cwd: commandCwd,
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    const cleanup = () => {
      clearTimeout(timeout);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      abortSignal?.removeEventListener("abort", abort);
    };

    const finish = (exitCode: number | null, signal: NodeJS.Signals | string | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({
        command,
        cwd: commandCwd,
        exitCode,
        signal,
        stdout: stdout.chunks.join(""),
        stderr: stderr.chunks.join(""),
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
        durationMs: Date.now() - startedAt,
      });
    };

    const requestKill = (reason: NodeJS.Signals | "timeout" | "abort") => {
      void killProcessTree(child.pid);
      fallbackTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null, reason === "timeout" ? "SIGTERM" : reason);
      }, 5_000);
      fallbackTimer.unref?.();
    };

    timeout = setTimeout(() => {
      timedOut = true;
      requestKill("timeout");
    }, timeoutMs);

    const abort = () => {
      requestKill("abort");
    };
    abortSignal?.addEventListener("abort", abort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      appendLimitedOutput(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      appendLimitedOutput(stderr, chunk);
    });
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
    child.once("close", (code, signal) => {
      finish(code, signal);
    });
  });
}

export async function editFileForTool(cwd: string, input: EditFileInput): Promise<EditFileOutput> {
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    throw new Error("edits must contain at least one replacement");
  }

  const filePath = resolveToolPath(cwd, input.path);
  const before = await readEditableTextFile(filePath);
  assertExpectedSha256(filePath, before.sha, input.expectedSha256);

  // Normalize line endings before matching so that LF-based oldText/newText
  // (which is what models typically emit) works against CRLF files checked
  // out on Windows. The file's dominant EOL style is restored on write.
  const eol = detectEol(before.text);
  let text = eol === "\r\n" ? before.text.replace(/\r\n/g, "\n") : before.text;
  let editsApplied = 0;
  for (const [index, edit] of input.edits.entries()) {
    if (!edit.oldText) {
      throw new Error(`edit ${index + 1} oldText must not be empty`);
    }
    const oldText = edit.oldText.replace(/\r\n/g, "\n");
    const newText = edit.newText.replace(/\r\n/g, "\n");
    const count = countOccurrences(text, oldText);
    if (count === 0) {
      throw new Error(`edit ${index + 1} oldText was not found in ${filePath}`);
    }
    if (count > 1 && !edit.replaceAll) {
      throw new Error(`edit ${index + 1} oldText matched ${count} times in ${filePath}; set replaceAll=true or provide more context`);
    }
    text = edit.replaceAll
      ? replaceAllLiteral(text, oldText, newText)
      : text.replace(oldText, newText);
    editsApplied += edit.replaceAll ? count : 1;
  }
  if (eol === "\r\n") {
    // After normalization above the buffer contains only \n, so this is safe.
    text = text.replace(/\n/g, "\r\n");
  }

  assertTextSize(filePath, text, MAX_EDIT_BYTES);
  const afterSha = sha256(text);
  const changed = afterSha !== before.sha;
  if (changed) {
    await atomicWriteTextFile(filePath, text);
  }

  return {
    path: filePath,
    beforeSha256: before.sha,
    afterSha256: afterSha,
    bytesWritten: changed ? Buffer.byteLength(text, "utf8") : 0,
    changed,
    editsApplied,
  };
}

export async function createFileForTool(cwd: string, input: CreateFileInput): Promise<FileWriteOutput> {
  const filePath = resolveToolPath(cwd, input.path);
  assertTextSize(filePath, input.content, MAX_CREATE_BYTES);

  let beforeSha: string | undefined;
  if (await pathExists(filePath)) {
    const existing = await readEditableTextFile(filePath);
    beforeSha = existing.sha;
    assertExpectedSha256(filePath, existing.sha, input.expectedSha256);
    if (!input.overwrite) {
      throw new Error(`File already exists: ${filePath}`);
    }
  } else if (input.expectedSha256) {
    throw new Error(`Cannot check expectedSha256 because file does not exist: ${filePath}`);
  }

  const afterSha = sha256(input.content);
  const changed = beforeSha !== afterSha;
  if (changed) {
    await atomicWriteTextFile(filePath, input.content);
  }

  return {
    path: filePath,
    ...(beforeSha ? { beforeSha256: beforeSha } : {}),
    afterSha256: afterSha,
    bytesWritten: changed ? Buffer.byteLength(input.content, "utf8") : 0,
    changed,
  };
}

export async function deleteFileForTool(cwd: string, input: DeleteFileInput): Promise<DeleteFileOutput> {
  const filePath = resolveToolPath(cwd, input.path);
  const before = await readEditableTextFile(filePath);
  assertExpectedSha256(filePath, before.sha, input.expectedSha256);
  await unlink(filePath);
  return {
    path: filePath,
    beforeSha256: before.sha,
    deleted: true,
  };
}

export async function moveFileForTool(cwd: string, input: MoveFileInput): Promise<MoveFileOutput> {
  const sourcePath = resolveToolPath(cwd, input.sourcePath);
  const destinationPath = resolveToolPath(cwd, input.destinationPath);
  const source = await readEditableTextFile(sourcePath);
  assertExpectedSha256(sourcePath, source.sha, input.expectedSourceSha256);

  let destinationSha: string | undefined;
  if (await pathExists(destinationPath)) {
    const destination = await readEditableTextFile(destinationPath);
    destinationSha = destination.sha;
    assertExpectedSha256(destinationPath, destination.sha, input.expectedDestinationSha256);
    if (!input.overwrite) {
      throw new Error(`Destination already exists: ${destinationPath}`);
    }
  } else if (input.expectedDestinationSha256) {
    throw new Error(`Cannot check expectedDestinationSha256 because destination does not exist: ${destinationPath}`);
  }

  await mkdir(dirname(destinationPath), { recursive: true });
  try {
    await rename(sourcePath, destinationPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await copyFile(sourcePath, destinationPath);
    await unlink(sourcePath);
  }

  return {
    sourcePath,
    destinationPath,
    sourceSha256: source.sha,
    ...(destinationSha ? { overwrittenDestinationSha256: destinationSha } : {}),
    moved: true,
  };
}

function expectedPatchHash(
  input: ApplyPatchInput,
  absolutePath: string,
  patchPath: string,
): string | undefined {
  return input.expectedSha256ByPath?.[absolutePath] ?? input.expectedSha256ByPath?.[patchPath];
}

export async function applyPatchForTool(cwd: string, input: ApplyPatchInput): Promise<ApplyPatchOutput> {
  const files = parseUnifiedPatch(input.patch);
  const changedFiles: ApplyPatchFileChange[] = [];

  for (const file of files) {
    const patchPath = file.newPath ?? file.oldPath;
    if (!patchPath) throw new Error("Patch file is missing both old and new paths");
    const targetPath = resolveToolPath(cwd, patchPath);
    const action: ApplyPatchFileChange["action"] =
      file.oldPath === null ? "create" :
      file.newPath === null ? "delete" :
      "edit";

    if (action === "create") {
      if (await pathExists(targetPath)) {
        throw new Error(`Patch target already exists: ${targetPath}`);
      }
      const text = applyParsedHunks(targetPath, "", file.hunks);
      assertTextSize(targetPath, text, MAX_CREATE_BYTES);
      await atomicWriteTextFile(targetPath, text);
      changedFiles.push({
        path: targetPath,
        action,
        afterSha256: sha256(text),
        bytesWritten: Buffer.byteLength(text, "utf8"),
      });
      continue;
    }

    const before = await readEditableTextFile(targetPath);
    assertExpectedSha256(targetPath, before.sha, expectedPatchHash(input, targetPath, patchPath));
    const text = applyParsedHunks(targetPath, before.text, file.hunks);

    if (action === "delete") {
      await unlink(targetPath);
      changedFiles.push({
        path: targetPath,
        action,
        beforeSha256: before.sha,
      });
      continue;
    }

    assertTextSize(targetPath, text, MAX_EDIT_BYTES);
    const afterSha = sha256(text);
    if (afterSha !== before.sha) {
      await atomicWriteTextFile(targetPath, text);
    }
    changedFiles.push({
      path: targetPath,
      action,
      beforeSha256: before.sha,
      afterSha256: afterSha,
      bytesWritten: afterSha !== before.sha ? Buffer.byteLength(text, "utf8") : 0,
    });
  }

  return { changedFiles };
}

export interface BuiltinFileToolsOptions {
  /** 权限门控：副作用工具（run_command/文件写操作）执行前会先经过 gate.check */
  permissionGate?: PermissionGate;
  /** session_search 工具的会话/原始日志目录（默认 ~/.deepccc/sessions 与 raw-stream-logs；测试可注入） */
  sessionSearch?: {
    contextDir?: string;
    rawLogsDir?: string;
  };
}

export function createBuiltinFileTools(
  cwd: string,
  options: BuiltinFileToolsOptions = {},
): ToolSet {
  const gate = options.permissionGate;

  /** 文件路径的候选匹配键：原始路径 + 绝对路径 + 相对 cwd 路径（正/反斜杠双版本，规则可任选其一） */
  const pathKeys = (p: string): string[] => {
    const abs = resolveToolPath(cwd, p);
    const rel = relative(cwd, abs);
    return [
      p,
      abs,
      rel,
      rel.split(sep).join("/"),
      abs.split(sep).join("/"),
    ];
  };

  /** 副作用工具执行前的权限守卫：gate 拒绝时抛错，工具不会真正执行 */
  const guard = async (request: PermissionRequest): Promise<void> => {
    if (!gate) return;
    const decision = await gate.check(request);
    if (decision === "deny") {
      throw new Error(
        `权限拒绝：${request.detail}（已按规则或用户选择拦截；如需放行请调整 ~/.deepccc/allow.json，或使用 --dangerously-bypass-permissions）`,
      );
    }
  };

  return {
    read_file: tool<ReadFileInput, ReadFileOutput>({
      description: "Read a UTF-8 text file from the local filesystem. Use line ranges for large files.",
      inputSchema: jsonSchema<ReadFileInput>({
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "Absolute path or path relative to the session cwd." },
          startLine: { type: "number", description: "Optional 1-based first line to return." },
          endLine: { type: "number", description: "Optional 1-based last line to return." },
        },
        required: ["path"],
      }),
      execute: (input) => readFileForTool(cwd, input),
    }),
    list_dir: tool<ListDirInput, ListDirOutput>({
      description: "List files in a local directory.",
      inputSchema: jsonSchema<ListDirInput>({
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "Directory path. Defaults to the session cwd." },
        },
      }),
      execute: (input) => listDirForTool(cwd, input),
    }),
    search_code: tool<SearchCodeInput, SearchCodeOutput>({
      description: "Search local files with ripgrep without invoking a shell.",
      inputSchema: jsonSchema<SearchCodeInput>({
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: "Text or regex query passed to ripgrep." },
          path: { type: "string", description: "File or directory to search. Defaults to the session cwd." },
          glob: { type: "string", description: "Optional ripgrep glob filter, for example **/*.ts." },
          maxResults: { type: "number", description: "Maximum result lines, capped internally." },
        },
        required: ["query"],
      }),
      execute: (input, options) => searchCodeForTool(cwd, input, options.abortSignal),
    }),
    run_command: tool<RunCommandInput, RunCommandOutput>({
      description: "Run a non-interactive shell command in the local workspace. Use for tests, git, and package scripts. Returns stdout/stderr and exitCode; non-zero exit codes are not tool errors.",
      inputSchema: jsonSchema<RunCommandInput>({
        type: "object",
        additionalProperties: false,
        properties: {
          command: { type: "string", description: "Command line to run in the platform shell." },
          cwd: { type: "string", description: "Optional working directory. Defaults to the session cwd." },
          timeoutMs: { type: "number", description: `Optional timeout in milliseconds, capped at ${MAX_COMMAND_TIMEOUT_MS}.` },
        },
        required: ["command"],
      }),
      execute: async (input, options) => {
        await guard({
          tool: "run_command",
          action: input.command,
          reason: isDangerousCommand(input.command) ? "high-risk" : "rule",
          detail: `运行命令: ${input.command}`,
        });
        return runCommandForTool(cwd, input, options.abortSignal);
      },
    }),
    edit_file: tool<EditFileInput, EditFileOutput>({
      description: "Edit an existing UTF-8 text file by applying exact oldText -> newText replacements. Uses optional SHA-256 precondition to avoid overwriting concurrent edits.",
      inputSchema: jsonSchema<EditFileInput>({
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "Absolute path or path relative to the session cwd." },
          expectedSha256: { type: "string", description: "Optional SHA-256 hash of the current file content." },
          edits: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                oldText: { type: "string", description: "Exact text to replace. Include enough context to make it unique." },
                newText: { type: "string", description: "Replacement text." },
                replaceAll: { type: "boolean", description: "Replace every occurrence when oldText appears multiple times." },
              },
              required: ["oldText", "newText"],
            },
          },
        },
        required: ["path", "edits"],
      }),
      execute: async (input) => {
        await guard({
          tool: "edit_file",
          action: input.path,
          altKeys: pathKeys(input.path),
          reason: "rule",
          detail: `编辑文件: ${input.path}`,
        });
        return editFileForTool(cwd, input);
      },
    }),
    create_file: tool<CreateFileInput, FileWriteOutput>({
      description: "Create a UTF-8 text file, or overwrite an existing one when overwrite=true.",
      inputSchema: jsonSchema<CreateFileInput>({
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "Absolute path or path relative to the session cwd." },
          content: { type: "string", description: "Complete file content to write." },
          overwrite: { type: "boolean", description: "Allow replacing an existing file." },
          expectedSha256: { type: "string", description: "Optional SHA-256 hash required when overwriting an existing file." },
        },
        required: ["path", "content"],
      }),
      execute: async (input) => {
        await guard({
          tool: "create_file",
          action: input.path,
          altKeys: pathKeys(input.path),
          reason: "rule",
          detail: `创建/覆盖文件: ${input.path}`,
        });
        return createFileForTool(cwd, input);
      },
    }),
    delete_file: tool<DeleteFileInput, DeleteFileOutput>({
      description: "Delete an existing text file. Use expectedSha256 to avoid deleting a file that changed after reading.",
      inputSchema: jsonSchema<DeleteFileInput>({
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "Absolute path or path relative to the session cwd." },
          expectedSha256: { type: "string", description: "Optional SHA-256 hash of the file that must be deleted." },
        },
        required: ["path"],
      }),
      execute: async (input) => {
        await guard({
          tool: "delete_file",
          action: input.path,
          altKeys: pathKeys(input.path),
          reason: "rule",
          detail: `删除文件: ${input.path}`,
        });
        return deleteFileForTool(cwd, input);
      },
    }),
    move_file: tool<MoveFileInput, MoveFileOutput>({
      description: "Move or rename an existing text file. Can overwrite an existing destination only when overwrite=true.",
      inputSchema: jsonSchema<MoveFileInput>({
        type: "object",
        additionalProperties: false,
        properties: {
          sourcePath: { type: "string", description: "Existing source file path." },
          destinationPath: { type: "string", description: "Destination file path." },
          overwrite: { type: "boolean", description: "Allow replacing an existing destination file." },
          expectedSourceSha256: { type: "string", description: "Optional SHA-256 hash of the source file." },
          expectedDestinationSha256: { type: "string", description: "Optional SHA-256 hash of the destination file when overwriting." },
        },
        required: ["sourcePath", "destinationPath"],
      }),
      execute: async (input) => {
        await guard({
          tool: "move_file",
          action: input.sourcePath,
          altKeys: pathKeys(input.sourcePath),
          reason: "rule",
          detail: `移动/重命名文件: ${input.sourcePath} → ${input.destinationPath}`,
        });
        return moveFileForTool(cwd, input);
      },
    }),
    apply_patch: tool<ApplyPatchInput, ApplyPatchOutput>({
      description: "Apply a unified diff patch to one or more UTF-8 text files. Prefer edit_file for small targeted edits.",
      inputSchema: jsonSchema<ApplyPatchInput>({
        type: "object",
        additionalProperties: false,
        properties: {
          patch: { type: "string", description: "Unified diff patch text." },
          expectedSha256ByPath: {
            type: "object",
            description: "Optional map of patch path or absolute path to expected SHA-256 before applying.",
            additionalProperties: { type: "string" },
          },
        },
        required: ["patch"],
      }),
      execute: async (input) => {
        await guard({
          tool: "apply_patch",
          action: "patch",
          reason: "rule",
          detail: "应用 unified diff patch",
        });
        return applyPatchForTool(cwd, input);
      },
    }),
    // 联网工具：只读外部网络操作，不触碰本地文件系统，无需权限询问
    websearch: tool<WebSearchInput, WebSearchOutput>({
      description:
        "Search the web (DuckDuckGo, no API key) and return matching titles, URLs, and snippets. Use when you need current or external information not available locally, e.g. latest docs, news, or package versions.",
      inputSchema: jsonSchema<WebSearchInput>({
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: "Search query." },
          maxResults: { type: "number", description: "Optional result count, default 5, capped at 10." },
        },
        required: ["query"],
      }),
      execute: (input, options) => webSearchForTool(input, { abortSignal: options.abortSignal }),
    }),
    webfetch: tool<WebFetchInput, WebFetchOutput>({
      description:
        "Fetch a URL and return its readable text content (HTML stripped, truncated). Use for documentation pages, articles, or API docs. Only http/https URLs are allowed.",
      inputSchema: jsonSchema<WebFetchInput>({
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", description: "http/https URL to fetch." },
          maxChars: { type: "number", description: "Optional text length cap, default 10000, capped at 100000." },
        },
        required: ["url"],
      }),
      execute: (input, options) => webFetchForTool(input, { abortSignal: options.abortSignal }),
    }),
    // 会话历史检索：只读 ~/.deepccc 存档，无需权限询问
    session_search: tool<SessionSearchInput, SessionSearchOutput>({
      description:
        "Search DeepCCC session archives by keyword and return matching snippets. Use when you need to recall old user messages, assistant replies, or tool calls from previous sessions. Multiple terms must all appear in the same message (AND, case-insensitive). Set include_raw_logs to also scan gzipped raw stream logs (slower).",
      inputSchema: jsonSchema<SessionSearchInput>({
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: "Keywords to search for (space-separated, all must match)." },
          session_id: { type: "string", description: "Optional session id to restrict the search to." },
          include_raw_logs: { type: "boolean", description: "Also scan gzipped raw stream logs under ~/.deepccc/raw-stream-logs. Default false." },
          max_results: { type: "number", description: "Maximum number of matches, capped at 50." },
        },
        required: ["query"],
      }),
      execute: (input) =>
        searchBuiltinSessions(input.query, {
          contextDir: options.sessionSearch?.contextDir,
          rawLogsDir: options.sessionSearch?.rawLogsDir,
          includeRawLogs: input.include_raw_logs ?? false,
          sessionId: input.session_id,
          maxResults: input.max_results,
        }),
    }),
  };
}
