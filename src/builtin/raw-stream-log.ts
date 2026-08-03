import { createWriteStream, type Dirent } from "node:fs";
import { mkdir, readdir, rm, stat, unlink } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import { createGzip } from "node:zlib";

export interface RawStreamLogOptions {
  enabled: boolean;
  rootDir: string;
  tool: string;
  sessionId: string;
  label: string;
  maxBytesPerTurn: number;
  retentionDays: number;
}

export interface RawStreamLogHandle {
  filePath: string;
  writeLine(line: string): void;
  close(options: { keep: boolean }): Promise<void>;
}

export function sanitizeLogPathSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^[._]+|_+$/g, "");
  return safe || "unknown";
}

async function cleanupOldRawStreamLogs(rootDir: string, retentionDays: number): Promise<void> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  const visit = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        try {
          await rm(path, { recursive: false });
        } catch {
          // Directory is not empty or already gone.
        }
        return;
      }

      if (!entry.isFile()) return;
      try {
        const info = await stat(path);
        if (info.mtimeMs < cutoff) await rm(path, { force: true });
      } catch {
        // Best-effort cleanup only.
      }
    }));
  };

  await visit(rootDir);
}

export async function createRawStreamLog(options: RawStreamLogOptions): Promise<RawStreamLogHandle | null> {
  if (!options.enabled) return null;

  const maxBytes = Math.max(0, Math.floor(options.maxBytesPerTurn));
  const tool = sanitizeLogPathSegment(options.tool);
  const session = sanitizeLogPathSegment(options.sessionId);
  const label = sanitizeLogPathSegment(options.label);
  const dir = join(options.rootDir, tool, session);
  await mkdir(dir, { recursive: true });
  void cleanupOldRawStreamLogs(join(options.rootDir, tool), options.retentionDays);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = join(dir, `${timestamp}-${label}.jsonl.gz`);
  const output = createWriteStream(filePath);
  const gzip = createGzip();
  gzip.pipe(output);

  let bytes = 0;
  let truncated = false;
  let ended = false;

  const writeLine = (line: string): void => {
    if (ended || truncated) return;
    const payload = `${line}\n`;
    const payloadBytes = Buffer.byteLength(payload, "utf-8");
    if (maxBytes > 0 && bytes + payloadBytes > maxBytes) {
      const marker = JSON.stringify({
        type: "deepccc_raw_stream_log_truncated",
        reason: "max_bytes_per_turn_exceeded",
        maxBytesPerTurn: maxBytes,
        writtenBytes: bytes,
      });
      gzip.write(`${marker}\n`);
      truncated = true;
      return;
    }
    bytes += payloadBytes;
    gzip.write(payload);
  };

  const close = async ({ keep }: { keep: boolean }): Promise<void> => {
    if (ended) return;
    ended = true;
    gzip.end();
    try {
      await once(output, "finish");
    } catch {
      // Ignore close errors; caller cannot recover from debug log failures.
    }
    if (!keep) {
      try {
        await unlink(filePath);
      } catch {
        // Best-effort cleanup only.
      }
    }
  };

  return { filePath, writeLine, close };
}
