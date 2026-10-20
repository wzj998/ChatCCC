import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ImagePart, ModelMessage, UserContent } from "ai";
import { AttachmentStore, buildAttachmentPrompt, parseAttachmentPrompt, MAX_ATTACHMENTS_PER_MESSAGE, type AttachmentMeta } from "./attachments.js";

// 24 MiB raw = 32 MiB inline, leaving room in DeepSeek's 48 MiB request body.
export const MAX_REQUEST_IMAGE_BYTES = 24 * 1024 * 1024;
export interface ImageUseNotice { model: string; count: number; mode: "native" | "analysis" }
export interface ReadImageInput { path: string; question?: string }
export interface ImageReference { kind: "deepccc_image"; attachment: AttachmentMeta; question: string }
type AnalyzeImages = (model: string, content: UserContent, signal?: AbortSignal) => Promise<string>;
interface Options {
  cwd: string;
  sessionId: string;
  store?: AttachmentStore;
  model: string;
  baseURL: string;
  visionModel?: string;
  analyze?: AnalyzeImages;
  onUse?: (notice: ImageUseNotice) => void;
}

/** Keep aliases out of persisted config; only official image requests use the current name. */
export function resolveImageModel(baseURL: string, model: string): string {
  if (model === "deepseek-v4-pro") throw new Error("当前 deepseek-v4-pro 未声明图片支持。请配置 visionModel（例如 deepseek-flash），或选择支持图片的主模型。");
  let official = false;
  try { official = new URL(baseURL).hostname === "api.deepseek.com"; } catch { /* custom provider */ }
  if (official && ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-chat", "deepseek-reasoner"].includes(model)) return "deepseek-flash";
  return model;
}

export function redactImageData(text: string): string {
  const inline = (value:string) => value.replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+/g, "[image data redacted]");
  const visit = (value:any):any => {
    if(typeof value === "string") {
      if(value.includes("image") && /^[\s]*[\[{]/.test(value)) { try { return JSON.stringify(visit(JSON.parse(value))); } catch { /* plain text */ } }
      return inline(value);
    }
    if(Array.isArray(value)) return value.map(visit);
    if(value && typeof value === "object") {
      if(value.type === "base64" && typeof value.media_type === "string" && value.media_type.startsWith("image/")) return {...value,data:"[image data redacted]"};
      if(value.type === "image" && value.image) return {...value,image:"[image data redacted]"};
      return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,visit(v)]));
    }
    return value;
  };
  if(text.includes("image")) { try { return JSON.stringify(visit(JSON.parse(text))); } catch { /* non-JSON error/message */ } }
  return inline(text);
}

function ensureDimensions(bytes: Buffer, mime: string): void {
  let width = 0, height = 0;
  if (mime === "image/png" && bytes.length >= 24) { width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); }
  else if (mime === "image/gif" && bytes.length >= 10) { width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8); }
  else if (mime === "image/jpeg") {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      if (marker === 0xff) { offset++; continue; }
      if (marker === 0xda || marker === 0xd9) break;
      const length = bytes.readUInt16BE(offset + 2);
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        height = bytes.readUInt16BE(offset + 5); width = bytes.readUInt16BE(offset + 7); break;
      }
      if (length < 2) break;
      offset += length + 2;
    }
  } else if (mime === "image/webp") {
    const chunk = bytes.subarray(12,16).toString("ascii");
    if (chunk === "VP8X" && bytes.length >= 30) { width = 1 + bytes.readUIntLE(24,3); height = 1 + bytes.readUIntLE(27,3); }
    else if (chunk === "VP8 " && bytes.length >= 30) { width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff; }
    else if (chunk === "VP8L" && bytes.length >= 25) {
      const bits = bytes.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
    }
  }
  if (!width || !height) throw new Error("无法读取图片尺寸，请提供有效的 PNG/JPEG/WebP/GIF 文件。");
  if (width > 8192 || height > 8192) throw new Error(`图片尺寸 ${width}×${height} 超过单边 8192 像素，请分图或缩小后发送。`);
}

/** References persist as text; binary data exists only while constructing a model request. */
export class ImageInputRuntime {
  readonly store: AttachmentStore;
  private observations = new Map<string, string>();
  private normalized = new Map<string, Promise<string>>();
  private notices = new Set<string>();
  constructor(private options: Options) { this.store = options.store ?? new AttachmentStore(); }

  private route() {
    const configured = this.options.visionModel?.trim();
    const model = resolveImageModel(this.options.baseURL, configured || this.options.model);
    return { model, mode: configured && configured !== this.options.model ? "analysis" as const : "native" as const };
  }

  async normalizePrompt(prompt: string): Promise<string> {
    if (!prompt.includes("<deepccc-attachments>") && !/^\[图片\][ \t]+/m.test(prompt)) return prompt;
    const previous = this.normalized.get(prompt);
    if (previous) return previous;
    if (this.normalized.size >= 64) this.normalized.delete(this.normalized.keys().next().value!);
    const pending = this.normalize(prompt);
    this.normalized.set(prompt,pending);
    try { return await pending; } catch (e) { this.normalized.delete(prompt); throw e; }
  }

  private async normalize(prompt: string): Promise<string> {
    const parsed = parseAttachmentPrompt(prompt);
    const paths: string[] = [];
    // Only actual user body image markers, not injected skill documentation.
    const split = parsed.text.lastIndexOf("[User message]");
    const prefix = split < 0 ? "" : parsed.text.slice(0,split + "[User message]".length);
    const body = split < 0 ? parsed.text : parsed.text.slice(split + "[User message]".length);
    const text = prefix + body.replace(/^\[图片\][ \t]+([^\r\n]+)$/gm, (_line,path: string)=>{ paths.push(path.trim()); return ""; });
    if (!paths.length && !parsed.attachments.length) return prompt;
    this.route();
    if (paths.length + parsed.attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new Error("每条消息最多 10 张图片。");
    const attachments: AttachmentMeta[] = [];
    for (const meta of parsed.attachments) {
      const existing = await this.store.get(this.options.sessionId,meta.attachmentId);
      attachments.push(existing && resolve(existing.absolutePath) === resolve(meta.absolutePath)
        ? existing : await this.store.importFile(this.options.sessionId,resolve(this.options.cwd,meta.absolutePath)));
    }
    for (const path of paths) attachments.push(await this.store.importFile(this.options.sessionId,resolve(this.options.cwd,path)));
    let total = 0;
    for (const meta of attachments) { const bytes = await this.load(meta); total += bytes.length; }
    if (total > MAX_REQUEST_IMAGE_BYTES) throw new Error("本条消息图片总大小超过 24 MiB，请分批发送。");
    return buildAttachmentPrompt(text.trim(),attachments);
  }

  async readImage(input: ReadImageInput): Promise<ImageReference> {
    this.route();
    const attachment = await this.store.importFile(this.options.sessionId,resolve(this.options.cwd,input.path));
    await this.load(attachment);
    return {kind:"deepccc_image",attachment,question:input.question?.trim() || "查看图片，描述与当前任务有关的细节和不确定之处。"};
  }

  private async load(meta: AttachmentMeta): Promise<Buffer> {
    const loaded = await this.store.read(this.options.sessionId,meta.attachmentId);
    if (!loaded) throw new Error(`图片附件已丢失或损坏：${meta.originalName}。请重新提供图片。`);
    ensureDimensions(loaded.bytes,loaded.attachment.mimeType);
    return loaded.bytes;
  }

  async prepare(input: readonly ModelMessage[], signal?: AbortSignal): Promise<{messages:ModelMessage[];hasImages:boolean;model?:string}> {
    const messages: ModelMessage[] = [];
    // Tool images are moved into a user message AFTER the complete tool batch;
    // DeepSeek Chat Completions accepts images only in user messages.
    let toolImages: ImageReference[] = [];
    const flushImages = () => {
      for (const ref of toolImages) messages.push({role:"user",content:buildAttachmentPrompt(ref.question,[ref.attachment])});
      toolImages = [];
    };
    for (const message of input) {
      if (message.role !== "tool") flushImages();
      messages.push(message);
      if (message.role === "tool") for (const part of message.content) {
        if (part.type !== "tool-result" || part.toolName !== "read_image" || part.output.type !== "json") continue;
        const ref = part.output.value as unknown as ImageReference;
        if (ref?.kind === "deepccc_image" && ref.attachment) toolImages.push(ref);
      }
    }
    flushImages();
    let count = 0, total = 0, hasImages = false;
    let imageModel: string | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      signal?.throwIfAborted();
      const message = messages[i];
      if (message.role !== "user" || typeof message.content !== "string") continue;
      const parsed = parseAttachmentPrompt(message.content);
      if (!parsed.attachments.length) continue;
      let route: ReturnType<ImageInputRuntime["route"]>;
      try { route = this.route(); } catch {
        messages[i] = {...message,content:`${parsed.text}\n[当前模型不能读取历史图片；如需查看请配置 visionModel。图片引用：${parsed.attachments.map(a=>a.absolutePath).join(", ")}]`};
        continue;
      }
      imageModel = route.model;
      const parts: ImagePart[] = [];
      const refs: string[] = [];
      const digests: string[] = [];
      for (const meta of parsed.attachments) {
        refs.push(`${meta.originalName}: ${meta.absolutePath}`);
        if (count >= MAX_ATTACHMENTS_PER_MESSAGE || total + meta.size > MAX_REQUEST_IMAGE_BYTES) continue;
        const bytes = await this.load(meta);
        total += bytes.length; count++;
        digests.push(createHash("sha256").update(bytes).digest("hex"));
        parts.push({type:"image",image:bytes,mediaType:meta.mimeType});
      }
      const references = `\n[图片引用]\n${refs.join("\n")}\n`;
      if (!parts.length) {
        messages[i] = {...message,content:parsed.text+references+"[历史图片未加载：本次图片预算已满，需要时调用 read_image 查看。]"};
        continue;
      }
      const text = parsed.text + references + (parts.length < parsed.attachments.length ? "[部分历史图片因预算省略，可用 read_image 查看。]" : "");
      const content: UserContent = [{type:"text",text},...parts];
      if (route.mode === "analysis") {
        const key = createHash("sha256").update(JSON.stringify([route.model,this.options.baseURL,parsed.text,digests])).digest("hex");
        const noteDir = join(this.store.rootDir,this.options.sessionId,"vision-notes");
        const notePath = join(noteDir,`${key}.json`);
        let observation = this.observations.get(key);
        if (!observation) {
          try { const saved=JSON.parse(await readFile(notePath,"utf8")); if(typeof saved.text==="string" && saved.text.trim()) observation=saved.text; } catch { /* first read */ }
        }
        if (!observation) {
          if (!this.options.analyze) throw new Error("图片模型分析器未配置");
          observation = await this.options.analyze(route.model,content,signal);
          if (!observation.trim()) throw new Error("图片模型未返回有效观察结果");
          try {
            await mkdir(noteDir,{recursive:true});
            const temp = `${notePath}.${process.pid}.tmp`;
            await writeFile(temp,JSON.stringify({model:route.model,text:observation}),"utf8");
            await rename(temp,notePath);
          } catch { /* A disposable cache failure must not discard a successful observation. */ }
        }
        if (this.observations.size >= 64) this.observations.delete(this.observations.keys().next().value!);
        this.observations.set(key,observation);
        messages[i] = {...message,content:`${text}\n[图片模型 ${route.model} 的观察；可能有误，精细追问请使用 read_image 并指定 question]\n${observation}`};
      } else { messages[i] = {...message,content}; hasImages = true; }
      const noticeKey=JSON.stringify([route.model,route.mode,digests]);
      if(!this.notices.has(noticeKey)){if(this.notices.size >= 64)this.notices.delete(this.notices.values().next().value!);this.notices.add(noticeKey);this.options.onUse?.({model:route.model,mode:route.mode,count:parts.length});}
    }
    return {messages,hasImages,model:imageModel};
  }
}
