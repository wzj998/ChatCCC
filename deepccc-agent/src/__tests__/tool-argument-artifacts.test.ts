import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuiltinContextManager, buildPersistedAssistantMessage } from "../context.js";
import { compactToolLoopMessages } from "../turn-context.js";
import { compactJsonValue, isOmittedToolArgument, omittedToolArgument } from "../tool-argument-replay.js";
import { createBuiltinFileTools } from "../file-tools.js";
import { MAX_TOOL_ARGUMENT_ARTIFACT_BYTES } from "../tool-argument-artifacts.js";

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, {recursive:true,force:true}))); });
async function manager(persist = true) {
  const dir = await mkdtemp(join(tmpdir(), "deepccc-arg-artifact-")); dirs.push(dir);
  return {dir, context:new BuiltinContextManager({contextDir:dir,sessionId:"artifact-test",persist})};
}
const code = "// actual 原始参数 🌱\n".repeat(800) + "console.log('complete');\n";
const preserve = (context:BuiltinContextManager) => context.preserveToolArgument;
function artifactName(marker:string):string {
  const match = marker.match(/artifact=([a-f0-9]{64}\.txt)/);
  expect(match, "omitted argument must identify a readable original artifact").not.toBeNull();
  return match![1];
}

describe("recoverable tool argument artifacts", () => {
  it("preserves the exact original input before persisted-history truncation and resume", async () => {
    const {dir,context} = await manager();
    const message = buildPersistedAssistantMessage({fullText:"",transcriptLines:[],maxTranscriptChars:600,
      toolCalls:[{id:"original-call",name:"run_script",input:JSON.stringify({language:"node",code}),output:'{"exitCode":0}'}],
      preserveToolArgument:preserve(context)});
    context.appendMessage(message);
    const stored = JSON.parse(message.toolCalls![0].input!);
    const filename = artifactName(stored.code);
    expect(filename).toBe(createHash("sha256").update(code).digest("hex")+".txt");
    expect(await readFile(join(dir,"artifact-test","tool-arguments",filename),"utf8")).toBe(code);
    const resumed = new BuiltinContextManager({contextDir:dir,sessionId:"artifact-test",persist:true});
    expect(JSON.parse(resumed.messages[0].toolCalls![0].input!).code).toBe(stored.code);
  });

  it("also preserves arguments evicted inside a live tool loop without mutating original calls", async () => {
    const {dir,context}=await manager();
    const original:any[]=[{role:"assistant",content:[{type:"tool-call",toolCallId:"live-call",toolName:"run_script",input:{language:"node",code}}]}];
    const compacted=compactToolLoopMessages(original,{maxToolInputChars:1000,keepRecentResults:0,preserveToolArgument:preserve(context)});
    const marker=(compacted.messages[0].content as any)[0].input.code;
    expect(await readFile(join(dir,"artifact-test","tool-arguments",artifactName(marker)),"utf8")).toBe(code);
    expect(original[0].content[0].input.code).toBe(code);
  });

  it("recognizes referenced artifact markers as unavailable executable arguments", () => {
    expect(isOmittedToolArgument(`[[DEEPCCC_OMITTED_TOOL_ARGUMENT artifact=${"a".repeat(64)}.txt]]`)).toBe(true);
  });

  it("deduplicates original values and reset removes only owned argument artifacts", async () => {
    const {dir,context}=await manager();
    expect(context.preserveToolArgument(code)).toBe(context.preserveToolArgument(code));
    expect(await readdir(context.toolArgumentArtifactDirectory)).toHaveLength(1);
    const keep=join(dir,"artifact-test","keep.txt");await writeFile(keep,"unrelated attachment");
    context.reset();
    await expect(access(context.toolArgumentArtifactDirectory)).rejects.toThrow();
    expect(await readFile(keep,"utf8")).toBe("unrelated attachment");
    expect(context.messages).toEqual([]);
  });

  it("rejects dot-only session identifiers before they can alias an enclosing artifact directory", async () => {
    const {dir}=await manager();const keep=join(dir,"tool-arguments","keep.txt");
    await mkdir(join(dir,"tool-arguments"));await writeFile(keep,"outside the session");
    for(const sessionId of [".","..","..."]){
      expect(()=>new BuiltinContextManager({contextDir:join(dir,"contexts"),sessionId,persist:true})).toThrow(/dot path segment/);
    }
    expect(await readFile(keep,"utf8")).toBe("outside the session");
  });

  it("does not create artifacts for ephemeral sessions or invent originals for legacy markers", async () => {
    const {dir,context}=await manager(false);
    expect(context.preserveToolArgument(code)).toBeUndefined();
    expect(await readdir(dir)).toEqual([]);
    const saved=await manager();
    expect(saved.context.preserveToolArgument(omittedToolArgument(1234))).toBeUndefined();
    await expect(access(saved.context.toolArgumentArtifactDirectory)).rejects.toThrow();
  });

  it("keeps a small JSON reference when many short fields do not fit the history budget", async () => {
    const {context}=await manager();
    const input=Object.fromEntries(Array.from({length:50},(_,i)=>["field"+i,"actual value ".repeat(3)]));
    const result=compactJsonValue(input,120,false,context.preserveToolArgument) as {__deepccc_input_artifact:string};
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(120);
    expect(JSON.parse(await readFile(join(context.toolArgumentArtifactDirectory,result.__deepccc_input_artifact),"utf8"))).toEqual(input);
  });

  it("never overwrites corrupted artifacts and rejects their contents before returning a read result", async () => {
    const {dir,context}=await manager();
    const marker=context.preserveToolArgument(code)!;const file=join(context.toolArgumentArtifactDirectory,artifactName(marker));
    await writeFile(file,"changed");
    const warning=vi.spyOn(console,"warn").mockImplementation(()=>{});
    expect(context.preserveToolArgument(code)).toBeUndefined();
    expect(await readFile(file,"utf8")).toBe("changed");
    expect(warning.mock.calls.flat().join(" ")).not.toContain(code.slice(0,30));
    const tools=createBuiltinFileTools(dir,{toolArgumentArtifactDir:context.toolArgumentArtifactDirectory}) as any;
    await expect(tools.read_file.execute({path:file})).rejects.toThrow(/content hash check/);
  });

  it("recovers original CRLF bytes through the managed file reader, including ranged reads", async () => {
    const {dir,context}=await manager();const text="// original\r\nconsole.log('原值');\r\n";
    const marker=context.preserveToolArgument(text)!;const file=join(context.toolArgumentArtifactDirectory,artifactName(marker));
    const tools=createBuiltinFileTools(dir,{toolArgumentArtifactDir:context.toolArgumentArtifactDirectory}) as any;
    expect((await tools.read_file.execute({path:file})).content).toBe(text);
    expect((await tools.read_file.execute({path:file,startLine:2,endLine:2})).content).toBe("console.log('原值');\r\n");
  });

  it("keeps NUL characters in an original string argument instead of treating it as an unknown binary file", async () => {
    const {dir,context}=await manager();const text="original\u0000string";
    const file=join(context.toolArgumentArtifactDirectory,artifactName(context.preserveToolArgument(text)!));
    const tools=createBuiltinFileTools(dir,{toolArgumentArtifactDir:context.toolArgumentArtifactDirectory}) as any;
    const result=await tools.read_file.execute({path:file});expect(result.isBinary).toBe(false);expect(result.content).toBe(text);
  });

  it("does not route referenced artifacts straight to execution or file writes", async () => {
    const {dir,context}=await manager();const marker=context.preserveToolArgument(code)!;
    const check=vi.fn().mockResolvedValue("allow");
    const tools=createBuiltinFileTools(dir,{permissionGate:{check} as never}) as any;
    await expect(tools.run_script.execute({language:"node",code:marker},{})).rejects.toThrow(/historical argument/);
    await expect(tools.create_file.execute({path:"never-written.txt",content:marker},{})).rejects.toThrow(/historical argument/);
    await expect(tools.create_file.execute({__deepccc_input_artifact:artifactName(marker)},{})).rejects.toThrow(/historical argument/);
    await expect(tools.run_process.execute({executable:process.execPath,args:["-e",marker]},{})).rejects.toThrow(/historical argument/);
    await writeFile(join(dir,"keep.txt"),"keep");
    await expect(tools.edit_file.execute({path:"keep.txt",old_string:"keep",new_string:marker},{})).rejects.toThrow(/historical argument/);
    expect(await readFile(join(dir,"keep.txt"),"utf8")).toBe("keep");
    expect(check).not.toHaveBeenCalled();await expect(access(join(dir,"never-written.txt"))).rejects.toThrow();
  });

  it("rejects damaged whole-value references before permissions, execution or writes",async()=>{
    const {dir}=await manager();const check=vi.fn().mockResolvedValue("allow");
    const tools=createBuiltinFileTools(dir,{permissionGate:{check} as never}) as any;
    const damaged=`[[DEEPCCC_OMITTED_TOOL_ARGUMENT artifact=${"a".repeat(63)}.txt]]`;
    for(const marker of [damaged,` \n${damaged}\n`,"[[DEEPCCC_OMITTED_TOOL_ARGUMENT artifact=broken"]){
      await expect(tools.run_script.execute({language:"node",code:marker},{})).rejects.toThrow(/historical argument/);
      await expect(tools.create_file.execute({path:"never-malformed.txt",content:marker},{})).rejects.toThrow(/historical argument/);
      await expect(tools.run_process.execute({executable:process.execPath,args:["-e",marker]},{})).rejects.toThrow(/historical argument/);
    }
    expect(check).not.toHaveBeenCalled();await expect(access(join(dir,"never-malformed.txt"))).rejects.toThrow();
  });

  it("points to the affected field and verified-name artifact without echoing other argument values",async()=>{
    const {dir,context}=await manager();const marker=context.preserveToolArgument(code)!;
    const check=vi.fn().mockResolvedValue("allow");
    const tools=createBuiltinFileTools(dir,{permissionGate:{check} as never,toolArgumentArtifactDir:context.toolArgumentArtifactDirectory}) as any;
    let error:unknown;
    try{await tools.run_process.execute({executable:process.execPath,args:["PRIVATE_VALUE_DO_NOT_ECHO",marker]},{});}catch(e){error=e;}
    const message=String(error);
    expect(message).toContain("input.args[1]");
    expect(message).toContain(join(context.toolArgumentArtifactDirectory,artifactName(marker)));
    expect(message).not.toContain("PRIVATE_VALUE_DO_NOT_ECHO");
    await expect(tools.run_script.execute({__deepccc_input_artifact:"broken"},{})).rejects.toThrow(/do not guess a hash/);
    expect(check).not.toHaveBeenCalled();
  });

  it("keeps unavailable fallback for inputs exceeding the readable artifact size limit", async () => {
    const {context}=await manager();
    expect(context.preserveToolArgument("x".repeat(MAX_TOOL_ARGUMENT_ARTIFACT_BYTES+1))).toBeUndefined();
    await expect(access(context.toolArgumentArtifactDirectory)).rejects.toThrow();
  });

  it("also retains exact inputs referenced through the persisted timeline", async () => {
    const {context}=await manager();
    const result=buildPersistedAssistantMessage({fullText:"",transcriptLines:[],
      timeline:[{type:"tool_use",id:"timeline-call",name:"run_script",input:JSON.stringify({language:"node",code:code.repeat(4)})}],
      preserveToolArgument:context.preserveToolArgument});
    const entry=result.timeline![0] as {input:string};const marker=JSON.parse(entry.input).code;
    expect(await readFile(join(context.toolArgumentArtifactDirectory,artifactName(marker)),"utf8")).toBe(code.repeat(4));
  });
});
