import { afterEach, expect, it, vi } from 'vitest';
import { jsonSchema } from 'ai';
const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));
vi.mock('ai', async original => ({ ...await original<typeof import('ai')>(), streamText: streamMock }));
import { DecisionSession } from '../decision-session.js';

const schema = jsonSchema<{action:string}>({type:'object',properties:{action:{type:'string'}},required:['action']}, {
  validate: (v:any) => v && typeof v.action === 'string' ? {success:true,value:v} : {success:false,error:new Error('Invalid')},
});
const model = {provider:'openai' as const,apiKey:'test-key',model:'test',baseURL:'https://example.invalid/v1'};
const request = {requestId:'test',stateVersion:1,context:{position:1},timeoutMs:1000};
const create = () => new DecisionSession(model,{systemPrompt:'Choose.',outputSchema:schema,outputMode:'json'});
function response(text:string, finish='stop') {
  return {fullStream:(async function*(){yield {type:'text-delta',text};yield {type:'finish',finishReason:finish};})()};
}
afterEach(()=>streamMock.mockReset());
it('requests JSON output without tools and validates repaired data locally',async()=>{
  streamMock.mockReturnValue(response('{"action":"literal ,} and ,]",}'));
  const result=await create().decide(request);
  expect(result).toMatchObject({status:'success',value:{action:'literal ,} and ,]'},metrics:{modelCalls:1,jsonRepairs:1}});
  const options=streamMock.mock.calls[0][0];
  expect(await options.output.responseFormat).toMatchObject({type:'json'});
  expect(options.tools).toBeUndefined();
  expect(options.toolChoice).toBeUndefined();
  expect(options.system).toContain('JSON');
});
it.each(['{"action":3,}','{"action":"wait",,}','{"action":','{"action":"wait"} prose','["wait"]'])('rejects invalid or incomplete JSON: %s',async text=>{
  streamMock.mockReturnValue(response(text));
  expect(await create().decide(request)).toMatchObject({status:'invalid_output'});
});
it('rejects truncated streams even with complete JSON',async()=>{
  streamMock.mockReturnValue(response('{"action":"wait"}','length'));
  expect(await create().decide(request)).toMatchObject({diagnostic:{code:'output_truncated'}});
});
it('does not accept JSON mode with tools or another protocol',()=>{
  expect(()=>new DecisionSession({...model,provider:'anthropic'},{systemPrompt:'Test',outputSchema:schema,outputMode:'json'})).toThrow();
  expect(()=>new DecisionSession(model,{systemPrompt:'Test',outputSchema:schema,outputMode:'json',allowedTools:['inspect']})).toThrow();
});
