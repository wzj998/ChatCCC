import type { IncomingMessage } from "node:http";
import { TextDecoder } from "node:util";

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
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new Error("Request body must be valid UTF-8 JSON");
  }
  return JSON.parse(text) as T;
}
