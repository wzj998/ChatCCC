import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { DEEPCCC_HOME } from "./config.js";
import { normalizeBuiltinSessionId } from "./context.js";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const ATTACHMENT_PROMPT_START = "<deepccc-attachments>";
export const ATTACHMENT_PROMPT_END = "</deepccc-attachments>";

export interface AttachmentMeta {
  attachmentId: string;
  originalName: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  size: number;
  absolutePath: string;
}

interface StoredAttachment extends AttachmentMeta {
  fileName: string;
}

export interface SaveAttachmentInput {
  originalName: string;
  bytes: Uint8Array;
}

export interface AttachmentStoreOptions {
  rootDir?: string;
  idFactory?: () => string;
}

export class AttachmentStore {
  readonly rootDir: string;
  private readonly idFactory: () => string;

  constructor(options: AttachmentStoreOptions = {}) {
    this.rootDir = resolve(options.rootDir ?? join(DEEPCCC_HOME, "attachments"));
    this.idFactory = options.idFactory ?? (() => randomUUID());
  }

  async save(sessionId: string, input: SaveAttachmentInput): Promise<AttachmentMeta> {
    const bytes = Buffer.from(input.bytes);
    if (!bytes.length) throw new Error("Image attachment must not be empty");
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error("Image attachment exceeds the 20 MB limit");
    const mimeType = detectImageMime(bytes);
    if (!mimeType) throw new Error("Only PNG, JPEG, or WebP image attachments are supported");

    const normalizedSessionId = normalizeBuiltinSessionId(sessionId);
    const attachmentId = normalizeAttachmentId(this.idFactory());
    const extension = extensionForMime(mimeType);
    const fileName = `${attachmentId}${extension}`;
    const sessionDir = this.sessionDir(normalizedSessionId);
    const absolutePath = join(sessionDir, fileName);
    const meta: StoredAttachment = {
      attachmentId,
      originalName: cleanOriginalName(input.originalName, extension),
      mimeType,
      size: bytes.length,
      absolutePath,
      fileName,
    };
    await mkdir(sessionDir, { recursive: true });
    const dataTemp = `${absolutePath}.${process.pid}.tmp`;
    const metaPath = this.metaPath(normalizedSessionId, attachmentId);
    const metaTemp = `${metaPath}.${process.pid}.tmp`;
    await writeFile(dataTemp, bytes);
    await rename(dataTemp, absolutePath);
    await writeFile(metaTemp, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    await rename(metaTemp, metaPath);
    return publicMeta(meta);
  }

  async importFile(sessionId: string, path: string): Promise<AttachmentMeta> {
    const absolutePath = resolve(path);
    const info = await stat(absolutePath).catch(() => null);
    if (!info?.isFile()) throw new Error(`Image attachment not found: ${path}`);
    if (info.size > MAX_ATTACHMENT_BYTES) throw new Error(`Image attachment exceeds the 20 MB limit: ${path}`);
    return this.save(sessionId, {
      originalName: basename(absolutePath),
      bytes: await readFile(absolutePath),
    });
  }

  async get(sessionId: string, attachmentId: string): Promise<AttachmentMeta | null> {
    const stored = await this.readStored(sessionId, attachmentId);
    return stored ? publicMeta(stored) : null;
  }

  async read(sessionId: string, attachmentId: string): Promise<{ attachment: AttachmentMeta; bytes: Buffer } | null> {
    const stored = await this.readStored(sessionId, attachmentId);
    if (!stored) return null;
    try {
      const bytes = await readFile(stored.absolutePath);
      if (bytes.length !== stored.size || detectImageMime(bytes) !== stored.mimeType) return null;
      return { attachment: publicMeta(stored), bytes };
    } catch {
      return null;
    }
  }

  async delete(sessionId: string, attachmentId: string): Promise<boolean> {
    const stored = await this.readStored(sessionId, attachmentId);
    if (!stored) return false;
    await Promise.all([
      unlink(stored.absolutePath).catch(() => {}),
      unlink(this.metaPath(sessionId, attachmentId)).catch(() => {}),
    ]);
    return true;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await rm(this.sessionDir(sessionId), { recursive: true, force: true });
  }

  private async readStored(sessionId: string, attachmentId: string): Promise<StoredAttachment | null> {
    const normalizedId = normalizeAttachmentId(attachmentId);
    try {
      const value = JSON.parse(await readFile(this.metaPath(sessionId, normalizedId), "utf8")) as Partial<StoredAttachment>;
      if (value.attachmentId !== normalizedId || typeof value.fileName !== "string") return null;
      if (typeof value.originalName !== "string" || typeof value.size !== "number") return null;
      if (value.mimeType !== "image/png" && value.mimeType !== "image/jpeg" && value.mimeType !== "image/webp") return null;
      if (value.fileName !== `${normalizedId}${extensionForMime(value.mimeType)}`) return null;
      const absolutePath = join(this.sessionDir(sessionId), value.fileName);
      return { ...value, absolutePath } as StoredAttachment;
    } catch {
      return null;
    }
  }

  private sessionDir(sessionId: string): string {
    return join(this.rootDir, normalizeBuiltinSessionId(sessionId));
  }

  private metaPath(sessionId: string, attachmentId: string): string {
    return join(this.sessionDir(sessionId), `${normalizeAttachmentId(attachmentId)}.json`);
  }
}

export function buildAttachmentPrompt(text: string, attachments: AttachmentMeta[]): string {
  const prompt = text.trim() || "请分析这些图片。";
  if (!attachments.length) return prompt;
  const manifest = attachments.map((attachment) => ({
    attachmentId: attachment.attachmentId,
    originalName: attachment.originalName,
    mimeType: attachment.mimeType,
    size: attachment.size,
    absolutePath: attachment.absolutePath,
  }));
  return [
    prompt,
    "",
    ATTACHMENT_PROMPT_START,
    JSON.stringify(manifest),
    ATTACHMENT_PROMPT_END,
    "以上图片以本地附件文件提供。不要假设模型原生支持图片；请使用可用工具读取这些绝对路径并自行处理。",
  ].join("\n");
}

export function parseAttachmentPrompt(content: string): { text: string; attachments: AttachmentMeta[] } {
  const start = content.indexOf(ATTACHMENT_PROMPT_START);
  const end = content.indexOf(ATTACHMENT_PROMPT_END, start + ATTACHMENT_PROMPT_START.length);
  if (start < 0 || end < 0) return { text: content, attachments: [] };
  const raw = content.slice(start + ATTACHMENT_PROMPT_START.length, end).trim();
  let attachments: AttachmentMeta[] = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) attachments = parsed.filter(isAttachmentMeta);
  } catch {
    return { text: content, attachments: [] };
  }
  return { text: content.slice(0, start).trimEnd(), attachments };
}

export function detectImageMime(bytes: Uint8Array): AttachmentMeta["mimeType"] | null {
  const buffer = Buffer.from(bytes);
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function extensionForMime(mimeType: AttachmentMeta["mimeType"]): string {
  return mimeType === "image/png" ? ".png" : mimeType === "image/jpeg" ? ".jpg" : ".webp";
}

function cleanOriginalName(value: string, extension: string): string {
  const cleaned = basename(value || `image${extension}`).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "_").slice(0, 180);
  return cleaned || `image${extension}`;
}

function normalizeAttachmentId(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!normalized || normalized === "." || normalized === "..") throw new Error("Invalid attachment id");
  return normalized;
}

function publicMeta(value: StoredAttachment): AttachmentMeta {
  const { fileName: _, ...meta } = value;
  return meta;
}

function isAttachmentMeta(value: unknown): value is AttachmentMeta {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const attachment = value as Partial<AttachmentMeta>;
  return typeof attachment.attachmentId === "string"
    && typeof attachment.originalName === "string"
    && typeof attachment.absolutePath === "string"
    && typeof attachment.size === "number"
    && (attachment.mimeType === "image/png" || attachment.mimeType === "image/jpeg" || attachment.mimeType === "image/webp");
}
