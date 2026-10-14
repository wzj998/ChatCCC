import {createServer} from 'node:http';
import {once} from 'node:events';
import {afterEach,expect,it} from 'vitest';
import {CompletionSession} from '../completion-session.js';
const servers:ReturnType<typeof createServer>[]=[];
afterEach(async()=>{for(const s of servers.splice(0)){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}});
it('preserves supplied messages and controls without tools or extra prompts',async()=>{
  const bodies:any[]=[];
  const server=createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;bodies.push(JSON.parse(text));
    res.writeHead(200,{'content-type':'text/event-stream'});
    const frame=(delta:unknown,finish:string|null)=>`data: ${JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:'example',choices:[{index:0,delta,finish_reason:finish}]})}\n\n`;
    res.end(frame({content:'{"ok":true}'},null)+frame({},'stop')+'data: [DONE]\n\n');
  });servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening');
  const port=(server.address() as {port:number}).port;
  const session=new CompletionSession({baseURL:`http://127.0.0.1:${port}/v1`,apiKey:'test-key',model:'example'});
  const messages=[{role:'system' as const,content:'Return JSON only.'},{role:'user' as const,content:'Keep this exact input.'}];
  const result=await session.complete({messages,timeoutMs:2000,json:true,temperature:0.3,maxOutputTokens:400,extensions:{thinking:{type:'disabled'}}});
  expect(result).toMatchObject({status:'success',content:'{"ok":true}'});
  expect(bodies[0]).toMatchObject({messages,temperature:0.3,max_tokens:400,response_format:{type:'json_object'},thinking:{type:'disabled'},stream:true});
  expect(bodies[0].tools).toBeUndefined();expect(bodies[0].tool_choice).toBeUndefined();
});
it('rejects extension overrides before sending requests',async()=>{
  const session=new CompletionSession({baseURL:'https://example.invalid/v1',apiKey:'test-key',model:'example'});
  await expect(session.complete({messages:[],timeoutMs:100,extensions:{messages:[]}})).rejects.toThrow(/extension/i);
});
it('bounds a stalled response',async()=>{
  const server=createServer(()=>{});servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening');
  const session=new CompletionSession({baseURL:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,apiKey:'test-key',model:'example'});
  expect(await session.complete({messages:[{role:'user',content:'test'}],timeoutMs:30})).toMatchObject({status:'timed_out'});
});
it.each(['length','tool_calls',null])('rejects incomplete finish %s without returning partial content',async finish=>{
  const server=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify({id:'t',object:'chat.completion.chunk',created:1,model:'example',choices:[{index:0,delta:{content:'private-marker'},finish_reason:finish}]})}\n\ndata: [DONE]\n\n`);});
  servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening');
  const session=new CompletionSession({baseURL:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,apiKey:'test-key',model:'example'});
  const result=await session.complete({messages:[{role:'user',content:'test'}],timeoutMs:2000});
  expect(result.status).toBe('invalid_output');expect(JSON.stringify(result)).not.toContain('private-marker');
});
it('redacts provider failures and exposes only status',async()=>{
  const server=createServer((req,res)=>{res.writeHead(429,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'private-marker'}}));});
  servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening');
  const session=new CompletionSession({baseURL:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,apiKey:'test-key',model:'example'});
  const result=await session.complete({messages:[{role:'user',content:'test'}],timeoutMs:2000});
  expect(result).toMatchObject({status:'error',diagnostic:{code:'provider_error',httpStatus:429}});
  expect(JSON.stringify(result)).not.toContain('private-marker');
});
it('rejects an already cancelled call without network activity',async()=>{
  const controller=new AbortController();controller.abort();
  const session=new CompletionSession({baseURL:'https://example.invalid/v1',apiKey:'test-key',model:'example'});
  expect(await session.complete({messages:[{role:'user',content:'test'}],timeoutMs:100},controller.signal)).toMatchObject({status:'cancelled',metrics:{modelCalls:0}});
});
