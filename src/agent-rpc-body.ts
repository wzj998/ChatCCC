import type { IncomingMessage } from "node:http";
import { TextDecoder } from "node:util";

// Windows 下 curl 传中文可能用 GBK 编码而非 UTF-8，按顺序尝试解码
const FALLBACK_ENCODINGS = ["gbk", "gb2312", "latin1"];

/**
 * 检测 UTF-8 解码结果是否看起来像乱码（GBK 字节被误当 UTF-8 解析）。
 * 典型特征：有 Latin-1 补充字符（U+0080-U+00FF）但没有 CJK 字符。
 */
function hasGarbledPattern(text: string): boolean {
  let latin1Count = 0;
  let cjkCount = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x4E00 && code <= 0x9FFF) cjkCount++;
    if (code >= 0x0080 && code <= 0x00FF) latin1Count++;
  }
  return latin1Count > 0 && cjkCount === 0;
}

function normalizeHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join("; ");
  return value ?? "";
}

export function getRequestCharset(req: IncomingMessage): string {
  const contentType = normalizeHeaderValue(req.headers["content-type"]);
  const match = contentType.match(/(?:^|;)\s*charset\s*=\s*("?)([^";\s]+)\1/i);
  return (match?.[2] ?? "utf-8").toLowerCase();
}

async function readLimitedBodyBuffer(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;

  return new Promise((resolve, reject) => {
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks, size)));
    req.on("error", reject);
  });
}

export async function readUtf8JsonBody<T>(req: IncomingMessage, maxBytes: number): Promise<T> {
  const charset = getRequestCharset(req);
  if (charset !== "utf-8" && charset !== "utf8") {
    throw new Error(`Unsupported charset: ${charset}. Use UTF-8 JSON.`);
  }

  const body = await readLimitedBodyBuffer(req, maxBytes);

  // 首选 UTF-8；若 JSON 解析失败则尝试常见中文编码
  // 注意：UTF-8 解码可能"成功"但实际是 GBK 字节被误当 UTF-8 解析，
  // 此时 JSON 也能解析通过但中文变成乱码。通过 hasGarbledPattern 检测
  // 这种"假成功"并回退到 GBK。
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    const parsed = JSON.parse(text) as T;
    if (hasGarbledPattern(text)) {
      // UTF-8 解码出的文本看起来像乱码，尝试 GBK
      try {
        const gbkText = new TextDecoder("gbk", { fatal: true }).decode(body);
        return JSON.parse(gbkText) as T;
      } catch {
        // GBK 也不行，用 UTF-8 结果
      }
    }
    return parsed;
  } catch {
    // UTF-8 解码失败，尝试其他编码
  }

  for (const enc of FALLBACK_ENCODINGS) {
    try {
      const text = new TextDecoder(enc, { fatal: true }).decode(body);
      return JSON.parse(text) as T;
    } catch {
      // 解码或 JSON 解析失败，尝试下一个编码
    }
  }
  const err = new Error("Request body must be valid UTF-8 JSON");
  (err as { rawBody?: Buffer }).rawBody = body;
  throw err;
}
