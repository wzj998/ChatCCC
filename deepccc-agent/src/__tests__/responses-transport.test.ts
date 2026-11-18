import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jsonSchema } from 'ai';
import { ChatSession, type ChatEvent } from '../index.js';
import { config, normalizeDeepCccProvider } from '../config.js';
import { CompletionSession } from '../completion-session.js';
import { DecisionSession } from '../decision-session.js';
import { summaryGenerationOptions } from '../model-provider.js';

const rawLogs = config.rawStreamLogs.enabled;
const dirs: string[] = [];
beforeEach(() => { config.rawStreamLogs.enabled = false; });
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); config.rawStreamLogs.enabled = rawLogs;
  for (const d of dirs.splice(0)) await rm(d, {recursive:true, force:true}); });

function response(output: unknown[]) {
  return { id: 'resp_test', object: 'response', created_at: 1, model: 'gpt-6.2-sol', status: 'completed',
    output, usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 }, error: null, incomplete_details: null };
}
const answer = { type: 'message', id: 'msg_test', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: 'Responses works', annotations: [] }] };
const reasoning = {type:'reasoning', id:'rs_test', summary:[{type:'summary_text',text:'Inspect the observation'}], encrypted_content:'encrypted-reasoning-test'};
const functionCall = (name: string, args: unknown) => ({type:'function_call',id:'fc_test',call_id:'call_test',name,arguments:JSON.stringify(args),status:'completed'});

/** Wire fixtures exercise the real SDK decoder, not mocked streamText. */
function streamed(output: any[]) {
  const events: any[] = [{type:'response.created',response:response([])}];
  output.forEach((item, output_index) => {
    events.push({type:'response.output_item.added',output_index,item:{...item,arguments:'',content:[],summary:[]}});
    if(item.type==='message') events.push({type:'response.output_text.delta',item_id:item.id,output_index,content_index:0,delta:item.content[0].text});
    if(item.type==='function_call') events.push({type:'response.function_call_arguments.delta',item_id:item.id,output_index,delta:item.arguments});
    if(item.type==='reasoning') {
      events.push({type:'response.reasoning_summary_part.added',item_id:item.id,output_index,summary_index:0,part:{type:'summary_text',text:''}});
      events.push({type:'response.reasoning_summary_text.delta',item_id:item.id,output_index,summary_index:0,delta:item.summary[0].text});
    }
    events.push({type:'response.output_item.done',output_index,item});
  });
  events.push({type:'response.completed',response:response(output)});
  return new Response(events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
}

function mockResponses(outputs: any[][], bodies: any[]) {
  vi.stubGlobal('fetch',vi.fn(async (url: string, init: RequestInit) => {
    expect(String(url)).toBe('https://example.invalid/v1/responses');
    const body=JSON.parse(String(init.body));bodies.push(body);
    const output=outputs.shift();if(!output) throw Error('Unexpected extra request');
    return body.stream ? streamed(output) : new Response(JSON.stringify(response(output)),{headers:{'content-type':'application/json'}});
  }));
}

describe('OpenAI Responses transport', () => {
  it('accepts explicit Responses while retaining the existing default', () => {
    expect(normalizeDeepCccProvider('OPENAI-RESPONSES')).toBe('openai-responses');
    expect(normalizeDeepCccProvider(undefined)).toBe('openai');
  });

  it('uses /responses, maps effort and output limits, and does not store requests', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      expect(String(url)).toBe('https://example.invalid/v1/responses');
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(response([answer])), { headers: { 'content-type': 'application/json' } });
    }));
    const session = new ChatSession({ provider: 'openai-responses', apiKey: 'test-key',
      baseURL: 'https://example.invalid/v1', model: 'gpt-6.2-sol', effort: 'high',
      maxOutputTokens: 512, streaming: false }, { persist: false, allowedTools: [] });
    const events = [];
    for await (const event of session.chat('hello')) events.push(event);
    expect(events.filter(e => e.type === 'error')).toEqual([]);
    expect(events.filter(e => e.type === 'text').map(e => e.text).join('')).toBe('Responses works');
    expect(bodies[0]).toMatchObject({ store: false, reasoning: { effort: 'high' }, max_output_tokens: 512,
      include: ['reasoning.encrypted_content'] });
    expect(bodies[0]).not.toHaveProperty('messages');
    expect(bodies[0]).not.toHaveProperty('reasoning_effort');
  });

  it.each([true,false])('executes tools and replays encrypted reasoning (streaming=%s)',async streaming=>{
    const cwd=await mkdtemp(join(tmpdir(),'responses-wire-'));dirs.push(cwd);
    const bodies:any[]=[];
    mockResponses([[reasoning,functionCall('list_dir',{path:'.'})],[answer],[answer]],bodies);
    const session=new ChatSession({provider:'openai-responses',apiKey:'test-key',baseURL:'https://example.invalid/v1',
      model:'gpt-6.2-sol',streaming},{cwd,persist:false,allowedTools:['list_dir']});
    const events=[];for await(const event of session.chat('List this folder'))events.push(event);
    expect(events.filter(e=>e.type==='error')).toEqual([]);
    expect(events.some(e=>e.type==='tool_result'&&e.name==='list_dir'&&!e.is_error)).toBe(true);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].tools).toEqual([expect.objectContaining({type:'function',name:'list_dir'})]);
    expect(bodies[1].input).toEqual(expect.arrayContaining([
      expect.objectContaining({type:'reasoning',encrypted_content:'encrypted-reasoning-test'}),
      expect.objectContaining({type:'function_call',call_id:'call_test',name:'list_dir'}),
      expect.objectContaining({type:'function_call_output',call_id:'call_test'}),
    ]));
    // Local structured history must also remain replayable on the next user turn.
    for await(const event of session.chat('Thanks'))expect(event.type).not.toBe('error');
    expect(bodies[2].input.some((i:any)=>i.type==='item_reference')).toBe(false);
    expect(bodies.every(b=>b.store===false)).toBe(true);
  });

  it('uses Responses for caller-owned completion JSON without leaking extensions into input',async()=>{
    const bodies:any[]=[];mockResponses([[{...answer,content:[{type:'output_text',text:'{"ok":true}',annotations:[]}]}]],bodies);
    const session=new CompletionSession({provider:'openai-responses',apiKey:'test-key',baseURL:'https://example.invalid/v1',model:'gpt-6.2-sol'});
    expect(await session.complete({messages:[{role:'user',content:'Return JSON.'}],json:true,temperature:0.2,timeoutMs:2000})).toMatchObject({status:'success',content:'{"ok":true}'});
    expect(bodies[0]).toMatchObject({store:false,text:{format:{type:'json_object'}}});
    expect(bodies[0]).not.toHaveProperty('temperature');
    await expect(session.complete({messages:[],timeoutMs:1000,extensions:{store:true}})).rejects.toThrow(/extension/);
  });

  it('retains reasoning during a bounded decision tool loop',async()=>{
    const bodies:any[]=[];mockResponses([[reasoning,functionCall('observe',{})],[functionCall('submit_result',{action:'wait'})]],bodies);
    const empty=jsonSchema<Record<string,never>>({type:'object',properties:{},additionalProperties:false}, {validate:v=>({success:true,value:v as Record<string,never>})});
    const output=jsonSchema<{action:string}>({type:'object',properties:{action:{type:'string'}},required:['action'],additionalProperties:false}, {validate:v=>({success:true,value:v as {action:string}})});
    const session=new DecisionSession({provider:'openai-responses',apiKey:'test-key',baseURL:'https://example.invalid/v1',model:'gpt-6.2-sol'},
      {systemPrompt:'Observe then decide',outputSchema:output,maxSteps:2,allowedTools:['observe'],tools:{observe:{description:'observe',inputSchema:empty,execute:()=>({observed:true})}}});
    expect(await session.decide({requestId:'r',stateVersion:1,context:{},timeoutMs:2000})).toMatchObject({status:'success',value:{action:'wait'}});
    expect(bodies[1].input).toEqual(expect.arrayContaining([expect.objectContaining({type:'reasoning',encrypted_content:'encrypted-reasoning-test'})]));
  });

  it('uses low effort without temperature for internal summaries',()=>{
    const options=summaryGenerationOptions('openai-responses');
    expect(options).not.toHaveProperty('temperature');
    expect(options.providerOptions).toMatchObject({openai:{store:false,reasoningEffort:'low'}});
  });

  it('does not accept a Responses stream that ends before response.completed',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    vi.stubGlobal('fetch',vi.fn(async()=>{
      const text=await streamed([answer]).text();
      return new Response(text.slice(0,text.lastIndexOf('data: ')),{headers:{'content-type':'text/event-stream'}});
    }));
    const session=new ChatSession({provider:'openai-responses',apiKey:'test-key',baseURL:'https://example.invalid/v1',model:'gpt-6.2-sol'},
      {persist:false,allowedTools:[]});
    const events: ChatEvent[]=[];
    const collect=async()=>{for await(const event of session.chat('hello'))events.push(event);};
    await expect(collect()).rejects.toThrow(/terminal response event/);
    expect(events.some(e=>e.type==='error')).toBe(true);
  });

  it('routes restored-context compaction through Responses with a supported summary effort',async()=>{
    const contextDir=await mkdtemp(join(tmpdir(),'responses-compaction-'));dirs.push(contextDir);
    const bodies:any[]=[];mockResponses([[answer],[answer],[answer]],bodies);
    const credentials={provider:'openai-responses' as const,apiKey:'test-key',baseURL:'https://example.invalid/v1',model:'gpt-6.2-sol',subModel:'',streaming:false};
    const seed=new ChatSession(credentials,{persist:true,contextDir,sessionId:'responses',compactAtTokens:10000,allowedTools:[]});
    for await(const event of seed.chat('old question'))expect(event.type).not.toBe('error');
    const restored=new ChatSession(credentials,{persist:true,contextDir,sessionId:'responses',compactAtTokens:1,keepRecentMessages:1,allowedTools:[]});
    const events=[];for await(const event of restored.chat('new question'))events.push(event);
    expect(events.some(e=>e.type==='compact')).toBe(true);
    expect(bodies[1]).toMatchObject({store:false,reasoning:{effort:'low'}});
    expect(bodies[1]).not.toHaveProperty('temperature');
  });
});
