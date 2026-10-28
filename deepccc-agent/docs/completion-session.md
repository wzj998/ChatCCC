# Caller-owned completions

`CompletionSession` is an opt-in stateless OpenAI-compatible transport. Pass the
entire `messages` array; no system guidance, workspace files, skills, tools,
history or compaction is injected. This is useful when comparing integrations
without rewriting their established prompt builders.

```js
import {CompletionSession} from 'deepccc';
const session = new CompletionSession({
  apiKey: process.env.DEEPCCC_API_KEY,
  baseURL: process.env.DEEPCCC_BASE_URL,
  model: process.env.DEEPCCC_MODEL,
});
const result = await session.complete({
  messages: [{role: 'system', content: 'Return JSON only.'},
             {role: 'user', content: 'Return an object with ok=true.'}],
  json: true, timeoutMs: 5000, maxOutputTokens: 256, temperature: 0.1,
});
if (result.status === 'success') console.log(result.content);
```

JSON mode sends `response_format: {type: 'json_object'}`; callers still parse,
validate and authorize results. No local syntax repair or automatic retry is
performed here. Completion is accepted only after a normal stop, never a length
limit or interrupted stream. Text mode preserves plain-text output. Parallel
calls do not share mutable history. `timeoutMs` covers stream consumption;
optional cancellation is the second argument. Context/response character limits
default to one million each. Since 0.2.28, oversized input returns
`status: 'context_limit'`, `diagnostic.code: 'context_budget_exceeded'` and zero
model calls before network activity. It does not return the input or partial
content. Invalid configuration budgets still throw. Other runtime failures return
fixed diagnostics without raw errors. Character limits are not token estimates;
callers must assemble bounded evidence rather than merely increase the limit.

JSON responses are collected as text without constructing partial objects for
each streamed fragment. This avoids unnecessary parsing and allocation for large
responses. Ordinary ChatSession, CLI and Web streaming behavior is unchanged.

Optional `extensions` passes caller-supplied provider-specific JSON options.
It cannot override messages, model, streaming, tool settings, response format,
temperature or token limits. Keep credentials in config, not extensions. No
messages, headers or generated content are logged or persisted by this class.
Metrics include duration and request count. Remote cancellation is best effort.
