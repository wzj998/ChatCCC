/** Opt-in stateless completion transport for integrations owning their complete prompts. */
import {createOpenAICompatible} from '@ai-sdk/openai-compatible';
import {streamText,type ModelMessage} from 'ai';
import {jsonObjectFetch} from './json-mode-fetch.js';

export interface CompletionConfig {baseURL:string;apiKey:string;model:string}
export interface CompletionRequest {
  messages:ModelMessage[];timeoutMs:number;json?:boolean;temperature?:number;maxOutputTokens?:number;
  /** Provider-specific JSON options; cannot replace transport, messages or tools. */
  extensions?:Record<string,unknown>;
  maxContextChars?:number;maxResponseChars?:number;
}
export type CompletionResult = {metrics:{durationMs:number;modelCalls:number}} & (
  {status:'success';content:string;reasoning:string} |
  {status:'timed_out'|'cancelled'|'invalid_output'|'error';diagnostic:{code:string;httpStatus?:number}});
const protectedKeys=new Set(['messages','model','stream','tools','tool_choice','response_format','temperature','max_tokens','max_completion_tokens']);
function positive(n:number):number{if(!Number.isSafeInteger(n)||n<1)throw new Error('Positive integer budget required');return n;}
function raceAbort<T>(work:PromiseLike<T>,signal:AbortSignal):Promise<T>{
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(new Error('Interrupted'));signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(work).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
    if(signal.aborted)abort();
  });
}
export class CompletionSession {
  constructor(private readonly config:CompletionConfig){if(!config.apiKey||!config.model)throw new Error('Model credentials required');}
  async complete(request:CompletionRequest,externalSignal?:AbortSignal):Promise<CompletionResult>{
    const started=performance.now(),timeout=positive(request.timeoutMs);
    if(timeout>2147483647)throw new Error('Deadline exceeds timer capacity');
    const messages=JSON.parse(JSON.stringify(request.messages)) as ModelMessage[];
    if(JSON.stringify(messages).length>positive(request.maxContextChars??1_000_000))throw new Error('Context budget exceeded');
    const extensions=JSON.parse(JSON.stringify(request.extensions??{}));
    if(Object.keys(extensions).some(key=>protectedKeys.has(key))||JSON.stringify(extensions).length>8192)throw new Error('Invalid request extension');
    const responseLimit=positive(request.maxResponseChars??1_000_000);
    if(request.maxOutputTokens!==undefined)positive(request.maxOutputTokens);
    const controller=new AbortController();let expired=false;
    const cancel=()=>controller.abort();externalSignal?.addEventListener('abort',cancel,{once:true});
    if(externalSignal?.aborted)cancel();
    const timer=setTimeout(()=>{expired=true;controller.abort();},timeout);
    let calls=0;
    const metrics=()=>({durationMs:performance.now()-started,modelCalls:calls});
    try{
      if(controller.signal.aborted)throw new Error('Interrupted');
      const transport=request.json?jsonObjectFetch():globalThis.fetch;
      const client=createOpenAICompatible({name:'completion',...this.config,includeUsage:true,
        fetch:async(url,init)=>transport(url,{...init,body:JSON.stringify({...JSON.parse(String(init?.body)),...extensions})})});
      calls++;
      const result=streamText({model:client(this.config.model),messages,allowSystemInMessages:true,temperature:request.temperature,maxOutputTokens:request.maxOutputTokens,
        maxRetries:0,abortSignal:controller.signal,onError:()=>{}});
      const iterator=result.fullStream[Symbol.asyncIterator]();
      let content='',reasoning='',finish:string|undefined;
      try{
        while(true){
          const next=await raceAbort(iterator.next(),controller.signal);
          if(controller.signal.aborted)throw new Error('Interrupted');
          if(next.done)break;
          const part=next.value;
          if(part.type==='error'){
            const status=(part.error as {statusCode?:unknown})?.statusCode;
            return {status:'error',diagnostic:{code:'provider_error',...(typeof status==='number'&&Number.isInteger(status)&&status>=100&&status<=599?{httpStatus:status}:{})},metrics:metrics()};
          }
          if(part.type==='text-delta')content+=part.text;
          if(part.type==='reasoning-delta')reasoning+=part.text;
          if(part.type==='finish')finish=part.finishReason;
          if(content.length+reasoning.length>responseLimit)return {status:'invalid_output',diagnostic:{code:'response_limit'},metrics:metrics()};
        }
        if(controller.signal.aborted)throw new Error('Interrupted');
        if(finish!=='stop')return {status:'invalid_output',diagnostic:{code:finish==='length'?'output_truncated':'incomplete_response'},metrics:metrics()};
        return {status:'success',content,reasoning,metrics:metrics()};
      }finally{try{void Promise.resolve(iterator.return?.()).catch(()=>{});}catch{/* best effort */}}
    }catch{return {status:expired?'timed_out':controller.signal.aborted?'cancelled':'error',diagnostic:{code:expired?'deadline_exceeded':controller.signal.aborted?'cancelled':'transport_error'},metrics:metrics()};}
    finally{clearTimeout(timer);externalSignal?.removeEventListener('abort',cancel);controller.abort();}
  }
}
