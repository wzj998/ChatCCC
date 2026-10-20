import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import { AttachmentStore, buildAttachmentPrompt, parseAttachmentPrompt } from "../attachments.js";
import { ImageInputRuntime, redactImageData, resolveImageModel } from "../multimodal.js";

const roots: string[] = [];
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6mS8AAAAASUVORK5CYII=", "base64");
async function fixture(extra = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "deepccc-vision-")); roots.push(cwd);
  const store = new AttachmentStore({ rootDir: join(cwd,"attachments") });
  const runtime = new ImageInputRuntime({cwd,sessionId:"s1",store,baseURL:"https://api.deepseek.com/v1",model:"deepseek-flash",...extra});
  return {cwd,store,runtime};
}
afterEach(async()=>{for(const p of roots.splice(0)) await rm(p,{recursive:true,force:true});});

it("converts IM paths with spaces and Web/CLI manifests to native image content, keeping history text-only",async()=>{
  const {cwd,runtime}=await fixture(); const path=join(cwd,"screen shot.png"); await writeFile(path,PNG);
  const prompt=await runtime.normalizePrompt(`看图\n[图片] ${path}`);
  expect(prompt).not.toContain("base64");
  const parsed=parseAttachmentPrompt(prompt); expect(parsed.attachments).toHaveLength(1);
  const result=await runtime.prepare([{role:"user",content:prompt}]);
  expect(result.hasImages).toBe(true);
  expect(result.messages[0].content).toEqual(expect.arrayContaining([expect.objectContaining({type:"image",mediaType:"image/png"})]));
  expect((await runtime.prepare([{role:"user",content:buildAttachmentPrompt("图",parsed.attachments)}])).hasImages).toBe(true);
});

it("keeps recent image references available after a subsequent text question",async()=>{
  const {cwd,runtime}=await fixture(); const path=join(cwd,"a.png"); await writeFile(path,PNG);
  const prompt=await runtime.normalizePrompt(`[图片] ${path}`);
  const messages:ModelMessage[]=[{role:"user",content:prompt},{role:"assistant",content:"描述"},{role:"user",content:"图的左边呢？"}];
  expect((await runtime.prepare(messages)).hasImages).toBe(true);
  expect(messages[0].content).toBe(prompt);
});

it("places read_image results in user image blocks without breaking tool pairs",async()=>{
  const {cwd,runtime}=await fixture(); await writeFile(join(cwd,"a.png"),PNG);
  const output=await runtime.readImage({path:"a.png"});
  const result=await runtime.prepare([{role:"assistant",content:[{type:"tool-call",toolCallId:"i",toolName:"read_image",input:{path:"a.png"}}]},{role:"tool",content:[{type:"tool-result",toolCallId:"i",toolName:"read_image",output:{type:"json",value:output as any}}]}]);
  expect(result.messages.map(m=>m.role)).toEqual(["assistant","tool","user"]);
  expect((result.messages[2].content as any[]).some(p=>p.type==="image")).toBe(true);
  expect(JSON.stringify(output)).not.toContain("base64");
});

it("uses configured vision analysis for a text-only main model and caches the observation",async()=>{
  const analyze=vi.fn(async()=>"图中有一个红色圆形。");
  const {cwd,runtime}=await fixture({model:"deepseek-v4-pro",visionModel:"deepseek-flash",analyze});
  await writeFile(join(cwd,"a.png"),PNG); const prompt=await runtime.normalizePrompt(`[图片] ${join(cwd,"a.png")}`);
  const prepared=await runtime.prepare([{role:"user",content:prompt}]);
  expect(prepared.hasImages).toBe(false); expect(JSON.stringify(prepared.messages)).toContain("红色圆形");
  expect(JSON.stringify(prepared.messages)).toContain("deepseek-flash");
  await runtime.prepare([{role:"user",content:prompt}]); expect(analyze).toHaveBeenCalledTimes(1);
});

it("rejects known text-only DeepSeek models without a vision model and resolves the legacy Flash alias only on the official host",async()=>{
  expect(resolveImageModel("https://api.deepseek.com/v1","deepseek-v4-flash")).toBe("deepseek-flash");
  expect(resolveImageModel("https://example.org/v1","deepseek-v4-flash")).toBe("deepseek-v4-flash");
  const {cwd,runtime}=await fixture({model:"deepseek-v4-pro"}); await writeFile(join(cwd,"a.png"),PNG);
  await expect(runtime.normalizePrompt(`[图片] ${join(cwd,"a.png")}`)).rejects.toThrow(/visionModel/);
});

it("rejects missing/corrupt images and enforces per-message count",async()=>{
  const {cwd,runtime}=await fixture(); await writeFile(join(cwd,"bad.png"),"not an image");
  await expect(runtime.normalizePrompt(`[图片] ${join(cwd,"bad.png")}`)).rejects.toThrow();
  await expect(runtime.normalizePrompt(`[图片] ${join(cwd,"missing.png")}`)).rejects.toThrow();
  await writeFile(join(cwd,"a.png"),PNG);
  await expect(runtime.normalizePrompt(Array.from({length:11},()=>`[图片] ${join(cwd,"a.png")}`).join("\n"))).rejects.toThrow(/10/);
});

it("redacts inline image data from raw request logs, including nested JSON strings",()=>{
  expect(redactImageData('body: "data:image/png;base64,ABCDEFG=="')).not.toContain("ABCDEFG");
  expect(redactImageData("normal text")).toBe("normal text");
  const anthropic={request:{body:JSON.stringify({messages:[{role:"user",content:[{type:"image",source:{type:"base64",media_type:"image/png",data:"SECRET_BASE64"}}]}]})}};
  expect(redactImageData(JSON.stringify(anthropic))).not.toContain("SECRET_BASE64");
});

it("preserves tool image chronology so old read_image calls cannot displace a new user image",async()=>{
  const {cwd,runtime,store}=await fixture();await writeFile(join(cwd,"old.png"),PNG);
  const old=await runtime.readImage({path:"old.png"});
  const latest=await store.save("s1",{originalName:"new.png",bytes:PNG});
  const result=await runtime.prepare([{role:"assistant",content:[{type:"tool-call",toolCallId:"old",toolName:"read_image",input:{}}]},{role:"tool",content:[{type:"tool-result",toolCallId:"old",toolName:"read_image",output:{type:"json",value:old as any}}]},{role:"user",content:buildAttachmentPrompt("最新图片",[latest])}]);
  expect(result.messages.map(m=>m.role)).toEqual(["assistant","tool","user","user"]);
  expect(JSON.stringify(result.messages.at(-1))).toContain("最新图片");
});

it("handles GIF input, oversized dimensions, cancellation and missing retained images explicitly",async()=>{
  const {store,runtime}=await fixture();
  const gif=await store.save("s1",{originalName:"a.gif",bytes:Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7","base64")});
  expect((await runtime.prepare([{role:"user",content:buildAttachmentPrompt("看图",[gif])}])).hasImages).toBe(true);
  const tooWide=Buffer.from(PNG);tooWide.writeUInt32BE(8193,16);
  const big=await store.save("s1",{originalName:"wide.png",bytes:tooWide});
  await expect(runtime.normalizePrompt(buildAttachmentPrompt("看图",[big]))).rejects.toThrow(/8192/);
  const controller=new AbortController();controller.abort();
  await expect(runtime.prepare([{role:"user",content:"x"}],controller.signal)).rejects.toThrow();
  await store.delete("s1",gif.attachmentId);
  await expect(runtime.prepare([{role:"user",content:buildAttachmentPrompt("看图",[gif])}])).rejects.toThrow(/丢失或损坏/);
});
