import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { ChatSession } from "../index.js";
import { AttachmentStore } from "../attachments.js";

const PNG="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6mS8AAAAASUVORK5CYII=";
const servers:Server[]=[]; const dirs:string[]=[];
afterEach(async()=>{for(const s of servers.splice(0)){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
for(const provider of ["openai","anthropic"] as const) it(`sends real images through ${provider}, survives restart and does not persist base64`,async()=>{
  const bodies:any[]=[];
  const server=createServer((req,res)=>{const chunks:Buffer[]=[];req.on("data",c=>chunks.push(c));req.on("end",()=>{
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));res.writeHead(200,{"content-type":"application/json"});
    res.end(JSON.stringify(provider==="openai"?{id:"c",object:"chat.completion",created:1,model:"vision-model",choices:[{index:0,message:{role:"assistant",content:"a small image"},finish_reason:"stop"}],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14}}:{id:"m",type:"message",role:"assistant",model:"vision-model",content:[{type:"text",text:"a small image"}],stop_reason:"end_turn",stop_sequence:null,usage:{input_tokens:10,output_tokens:4}}));
  });});servers.push(server);await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  const address=server.address();if(!address||typeof address==="string")throw Error("no port");
  const cwd=await mkdtemp(join(tmpdir(),"deepccc-image-wire-"));dirs.push(cwd);const path=join(cwd,"image with spaces.png");await writeFile(path,Buffer.from(PNG,"base64"));
  const options={cwd,sessionId:"wire",persist:true,contextDir:join(cwd,"sessions"),attachmentStore:new AttachmentStore({rootDir:join(cwd,"attachments")})};
  const config={apiKey:"test",provider,baseURL:`http://127.0.0.1:${address.port}/v1`,model:"vision-model",visionModel:"",streaming:false,effort:""};
  const notices:any[]=[];
  for await(const event of new ChatSession(config,options).chat(`请看图\n[图片] ${path}`))if(event.type==="image_input")notices.push(event);
  for await(const _ of new ChatSession(config,options).chat("再说一下图片颜色")) {}
  for(const body of bodies){
    const user=body.messages.find((m:any)=>m.role==="user"&&Array.isArray(m.content));
    if(provider==="openai")expect(user.content).toContainEqual({type:"image_url",image_url:{url:`data:image/png;base64,${PNG}`}});
    else expect(user.content).toContainEqual({type:"image",source:{type:"base64",media_type:"image/png",data:PNG}});
  }
  expect(notices).toContainEqual({type:"image_input",model:"vision-model",count:1,mode:"native"});
  const persisted=await readFile(join(cwd,"sessions/wire/context.json"),"utf8");expect(persisted).not.toContain(PNG);expect(persisted).toContain("attachmentId");
});

it("delivers read_image tool output to the next model step as a user image",async()=>{
  const bodies:any[]=[];
  const cwd=await mkdtemp(join(tmpdir(),"deepccc-readimage-wire-"));dirs.push(cwd);await writeFile(join(cwd,"result.png"),Buffer.from(PNG,"base64"));
  const server=createServer((req,res)=>{const chunks:Buffer[]=[];req.on("data",c=>chunks.push(c));req.on("end",()=>{
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));const first=bodies.length===1;
    res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({id:"c",object:"chat.completion",created:1,model:"vision-model",choices:[{index:0,message:first?{role:"assistant",content:null,tool_calls:[{id:"call-image",type:"function",function:{name:"read_image",arguments:JSON.stringify({path:"result.png",question:"看图"})}}]}:{role:"assistant",content:"image inspected"},finish_reason:first?"tool_calls":"stop"}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
  });});servers.push(server);await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const a=server.address();if(!a||typeof a==="string")throw Error("port");
  const session=new ChatSession({apiKey:"test",provider:"openai",baseURL:`http://127.0.0.1:${a.port}/v1`,model:"vision-model",visionModel:"",streaming:false},{cwd,attachmentStore:new AttachmentStore({rootDir:join(cwd,"attachments")})});
  for await(const _ of session.chat("查看 result.png")){}
  expect(bodies).toHaveLength(2);
  expect(bodies[1].messages.some((m:any)=>m.role==="user"&&Array.isArray(m.content)&&m.content.some((p:any)=>p.type==="image_url"))).toBe(true);
  expect(bodies[1].messages.some((m:any)=>m.role==="tool"&&m.tool_call_id==="call-image")).toBe(true);
});

it("routes pictures through the configured vision model before a text-only main request",async()=>{
  const bodies:any[]=[];const cwd=await mkdtemp(join(tmpdir(),"deepccc-fallback-wire-"));dirs.push(cwd);await writeFile(join(cwd,"a.png"),Buffer.from(PNG,"base64"));
  const server=createServer((req,res)=>{const chunks:Buffer[]=[];req.on("data",c=>chunks.push(c));req.on("end",()=>{
    const body=JSON.parse(Buffer.concat(chunks).toString());bodies.push(body);res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({id:"c",object:"chat.completion",created:1,model:body.model,choices:[{index:0,message:{role:"assistant",content:body.model==="vision-helper"?"a white square":"analysed"},finish_reason:"stop"}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
  });});servers.push(server);await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const a=server.address();if(!a||typeof a==="string")throw Error("port");
  const session=new ChatSession({apiKey:"test",provider:"openai",baseURL:`http://127.0.0.1:${a.port}/v1`,model:"deepseek-v4-pro",visionModel:"vision-helper",streaming:false},{cwd,attachmentStore:new AttachmentStore({rootDir:join(cwd,"attachments")})});
  const notices:any[]=[];for await(const e of session.chat(`[图片] ${join(cwd,"a.png")}`))if(e.type==="image_input")notices.push(e);
  expect(bodies.map(b=>b.model)).toEqual(["vision-helper","deepseek-v4-pro"]);
  expect(JSON.stringify(bodies[0])).toContain("image_url");
  expect(JSON.stringify(bodies[1])).not.toContain(PNG);
  expect(JSON.stringify(bodies[1].messages)).toContain("a white square");
  expect(notices).toContainEqual({type:"image_input",model:"vision-helper",mode:"analysis",count:1});
});
