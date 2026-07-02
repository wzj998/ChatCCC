import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import { jsonSchema, tool, type ToolSet } from "ai";

const MAX_READ_BYTES = 1024 * 1024;
const MAX_LIST_ENTRIES = 200;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_BYTES = 256 * 1024;
const MAX_EDIT_BYTES = 2 * 1024 * 1024;
const MAX_CREATE_BYTES = 2 * 1024 * 1024;
const MAX_PATCH_BYTES = 512 * 1024;
const SEARCH_TIMEOUT_MS = 15_000;

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

function resolveToolPath(cwd: string, value: string | undefined): string {
  const raw = value?.trim();
  if (!raw) return resolve(cwd);
  return isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
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

export async function searchCodeForTool(
  cwd: string,
  input: SearchCodeInput,
  signal?: AbortSignal,
): Promise<SearchCodeOutput> {
  const query = input.query?.trim();
  if (!query) throw new Error("query is required");

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

  const output = await new Promise<{ stdout: string; stderr: string; truncated: boolean }>((resolvePromise, reject) => {
    const child = spawn("rg", args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`search_code timed out after ${SEARCH_TIMEOUT_MS}ms`));
    }, SEARCH_TIMEOUT_MS);

    const abort = () => {
      child.kill();
      reject(new Error("search_code aborted"));
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
    child.on("error", (err) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (code !== 0 && code !== 1) {
        reject(new Error(stderr.trim() || `rg exited with code ${code}`));
        return;
      }
      resolvePromise({ stdout, stderr, truncated });
    });
  });

  const matches = output.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map(parseRgLine)
    .filter((match): match is SearchCodeMatch => !!match)
    .slice(0, maxResults);

  return {
    query,
    path: searchPath,
    ...(input.glob?.trim() ? { glob: input.glob.trim() } : {}),
    matches,
    truncated: output.truncated || matches.length >= maxResults,
  };
}

export async function editFileForTool(cwd: string, input: EditFileInput): Promise<EditFileOutput> {
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    throw new Error("edits must contain at least one replacement");
  }

  const filePath = resolveToolPath(cwd, input.path);
  const before = await readEditableTextFile(filePath);
  assertExpectedSha256(filePath, before.sha, input.expectedSha256);

  let text = before.text;
  let editsApplied = 0;
  for (const [index, edit] of input.edits.entries()) {
    if (!edit.oldText) {
      throw new Error(`edit ${index + 1} oldText must not be empty`);
    }
    const count = countOccurrences(text, edit.oldText);
    if (count === 0) {
      throw new Error(`edit ${index + 1} oldText was not found in ${filePath}`);
    }
    if (count > 1 && !edit.replaceAll) {
      throw new Error(`edit ${index + 1} oldText matched ${count} times in ${filePath}; set replaceAll=true or provide more context`);
    }
    text = edit.replaceAll
      ? replaceAllLiteral(text, edit.oldText, edit.newText)
      : text.replace(edit.oldText, edit.newText);
    editsApplied += edit.replaceAll ? count : 1;
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

export function createBuiltinFileTools(cwd: string): ToolSet {
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
      execute: (input) => editFileForTool(cwd, input),
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
      execute: (input) => createFileForTool(cwd, input),
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
      execute: (input) => deleteFileForTool(cwd, input),
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
      execute: (input) => moveFileForTool(cwd, input),
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
      execute: (input) => applyPatchForTool(cwd, input),
    }),
  };
}
