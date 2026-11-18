/** Explicit transports: legacy OpenAI-compatible, native Responses, and Anthropic. */
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { JSONObject } from '@ai-sdk/provider';
import type { DeepCccProvider } from './config.js';
import { wrapLanguageModel } from 'ai';

export function createModelProvider(provider: DeepCccProvider, credentials: {
  apiKey: string; baseURL: string; fetch?: typeof fetch;
}) {
  if (provider === 'openai-responses') {
    const client = createOpenAI({ ...credentials, baseURL: credentials.baseURL.trim().replace(/\/+$/, '') });
    return (modelId: string) => wrapLanguageModel({ model: client.responses(modelId), middleware: {
      specificationVersion: 'v3',
      transformParams: async ({params, type}) => ({...params, ...(type === 'stream' ? {includeRawChunks:true} : {})}),
      wrapStream: async ({doStream}) => {
        const result = await doStream();
        let terminal = false;
        return {...result, stream: result.stream.pipeThrough(new TransformStream({
          transform(chunk, controller) {
            if (chunk.type === 'raw') {
              const event = chunk.rawValue as {type?:string};
              if (['response.completed','response.incomplete','response.failed'].includes(event?.type ?? '')) terminal = true;
              return;
            }
            // The SDK can synthesize finish after a clean EOF. That must not
            // turn an interrupted HTTP/SSE response into a successful agent turn.
            if (chunk.type === 'finish' && !terminal) {
              controller.enqueue({type:'error',error:new Error('Responses stream ended before a terminal response event')});
              return;
            }
            controller.enqueue(chunk);
          },
        }))};
      },
    }});
  }
  if (provider === 'anthropic') {
    return createAnthropic({ ...credentials, baseURL: credentials.baseURL.trim().replace(/\/+$/, '') });
  }
  return createOpenAICompatible({ name: 'deepccc', ...credentials, includeUsage: true });
}

export function modelProviderOptions(provider: DeepCccProvider, effort?: string): Record<string, JSONObject> | undefined {
  if (provider === 'openai-responses') {
    // DeepCCC owns history/compaction. Replay encrypted reasoning within tool loops
    // rather than relying on server-side item references or retained responses.
    return { openai: { store: false, include: ['reasoning.encrypted_content'],
      strictJsonSchema: false, ...(effort ? { reasoningEffort: effort } : {}) } };
  }
  if (!effort) return undefined;
  return provider === 'anthropic' ? { anthropic: { effort } } : { deepccc: { reasoningEffort: effort } };
}

/** Reasoning-only Responses models reject temperature and effort=none. */
export function summaryGenerationOptions(provider: DeepCccProvider) {
  return { ...(provider === 'openai-responses' ? {} : { temperature: 0 }),
    providerOptions: modelProviderOptions(provider, provider === 'openai' ? 'none' : 'low') };
}
