# Bounded structured decisions

`DecisionSession` is an opt-in, programmatic, text-only API for integrations that
own their state and need a bounded decision loop. Existing `ChatSession`, CLI and
Web behavior is unchanged. The model client is reusable, but each `decide()` call
starts with exactly the supplied context. No conversation history, workspace
instructions, global skills, file tools, model-based compaction or raw stream
logging is loaded automatically.

This is not a simulator, a game-specific policy or a guarantee of model latency.
Use an adapter to provide observations, validate decisions against current state,
and execute actions. Keep application knowledge and private data outside the
package. Read any skill references at application setup, then pass the relevant
instructions through `systemPrompt`.

## Minimal integration

```js
import { DecisionSession } from 'deepccc';
import { jsonSchema } from 'ai';

const outputSchema = jsonSchema({
  type: 'object',
  properties: { action: { type: 'string', enum: ['left', 'right', 'wait'] } },
  required: ['action'],
  additionalProperties: false,
}, {
  validate(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === 1
        && ['left', 'right', 'wait'].includes(value.action)) {
      return { success: true, value };
    }
    return { success: false, error: new Error('Invalid decision') };
  },
});

const session = new DecisionSession({
  model: process.env.DEEPCCC_MODEL,
  effort: '', // Omit effort when the target service does not support it.
  maxOutputTokens: 2048,
}, {
  systemPrompt: 'Choose a safe action toward the supplied goal. Unknown data stays unknown.',
  outputSchema,
  maxSteps: 1,
  maxContextChars: 32000,
});

const result = await session.decide({
  requestId: 'example-request-1',
  stateVersion: 3,
  timeoutMs: 5000,
  context: {
    observation: { position: 1, blocked: [0] },
    goal: { position: 4 },
    plan: null,
    memory: [],
  },
});

if (result.status === 'success') {
  // Re-check result.stateVersion and legality in the adapter before execution.
  console.log(result.value);
} else {
  console.log(result.status); // Never execute partial text as an action.
}
```

The default Provider/model/credentials are resolved in the same way as
`ChatSession`. This API always consumes a structured streaming response;
`streaming` and `subModel` from ChatSession configuration are not decision options.
There is no summarization call or hidden model switch.

`outputSchema` and allowed tool input schemas **must contain runtime validators**.
Use a Standard Schema supported by the AI SDK, or `jsonSchema(schema, {validate})`.
A JSON schema alone describes the model contract but is not a runtime safety
check, so the constructor rejects schemas without validators. Validators may be
asynchronous and share the request deadline. The provider must support tool calls.
The default `outputMode: 'tools'` uses the reserved `submit_result` tool; free-form
JSON text is not accepted as an alternative in that mode.

Since 0.2.24, `outputMode: 'json'` is available for OpenAI-compatible endpoints.
It sends `response_format: {type: 'json_object'}` with no tools or tool choice;
the schema is included in the system prompt and runtime validation is still
mandatory. Nonempty `allowedTools` and other provider protocols are rejected in
this mode. JSON syntax constraints do not guarantee semantic correctness.
One local fallback removes trailing commas outside quoted strings, preserving
values and escapes. Missing values, truncated streams, prose and invalid schemas
are rejected; no extra model request is made for syntax recovery. Optional
`metrics.jsonRepairs` counts repaired responses. Deadlines, cancellation, size
limits, freshness checks and caller-owned context remain unchanged.

JSON mode collects streamed text and parses the completed response once, rather
than constructing intermediate partial objects. Final syntax recovery and schema
validation remain mandatory. Tools mode and ordinary ChatSession are unchanged.

## Explicit capabilities

Supply a `tools` record with `description`, `inputSchema` and `execute`, and list
the capabilities to expose in `allowedTools`. Supplying a tool does **not** enable
it. Both default to empty. Tool names must begin with a letter and use only
letters, digits or underscores (at most 64 characters); `submit_result` is reserved.

```js
const options = {
  systemPrompt: 'Inspect relevant information only when needed, then submit a result.',
  outputSchema,
  maxSteps: 2, // one inspection step plus one final submission
  maxToolCalls: 2,
  allowedTools: ['inspect_state'],
  tools: {
    inspect_state: {
      description: 'Return a compact observation for the supplied request.',
      inputSchema: jsonSchema({ type: 'object', additionalProperties: false }, {
        validate(value) {
          return value && typeof value === 'object' && !Array.isArray(value)
            && Object.keys(value).length === 0
            ? { success: true, value }
            : { success: false, error: new Error('Expected empty input') };
        },
      }),
      async execute(input, { signal, requestId, stateVersion }) {
        // Your adapter must honor signal and return a small JSON-serializable value.
        return adapter.observe({ signal, requestId, stateVersion });
      },
    },
  },
};
```

The entire model tool batch is checked before any tool runs. Unknown names,
invalid inputs, duplicate call IDs and mixing a final submission with other
calls fail closed. Tools execute sequentially and receive the same cancellation
signal and request identity. They are not given to the SDK for automatic execution.
The last permitted model step must submit a result; it cannot start more tools.

Prefer observation-only capabilities. A tool allowlist is not an OS sandbox.
Register trusted code only. Cancellation cannot undo effects of a tool that already
started. Idempotency, freshness and actual execution acknowledgements are adapter
responsibilities. Returned identity allows the adapter to reject stale decisions;
the core does not know whether external state has changed.

## Budgets and results

| Option | Default | Meaning |
| --- | --- | --- |
| request `timeoutMs` | Required | One wall-clock budget across generation, tools and validation |
| `maxSteps` | 1 | Model requests, including final submission |
| `maxToolCalls` | 4 | Total non-submission calls in a decision |
| `maxContextChars` | 32000 | System prompt plus serialized messages |
| `maxToolResultChars` | 8000 | Each serialized observation |
| `maxResponseChars` | 32000 | Bounded streamed text/tool data; may count tool arguments twice |
| model `maxOutputTokens` | Configured value, otherwise 2048 | Per-request provider output budget, including reasoning where applicable |

Character budgets are protective size limits, not token estimates. Oversized
state/results fail with `context_limit`; they are never silently truncated or
summarized. Keep raw logs outside decision context. Assemble the latest state,
active plan and selected evidence before calling the API. Background summaries
should produce versioned memory snapshots rather than mutate an in-flight request.

`success` is the only status carrying a validated `value`. Other statuses are
`timed_out`, `cancelled`, `invalid_output`, `step_limit`, `tool_error`,
`context_limit` and `error`. Metrics report total/model/tool milliseconds, model
and tool call counts, and the last assembled context size. Provider/tool error
payloads and partial generated content are not copied into result messages.
Invalid configuration/request budgets throw before contacting the provider.

Since 0.2.23, failures also include a safe `diagnostic` object with a fixed `code`
and `stage`. Categories distinguish provider errors, invalid tool input, result
schema failures, truncated output, interrupted output, deadlines and cancellation.
Provider HTTP status is included when available, but error messages, raw tool
arguments, prompts, headers and response bodies are never copied into diagnostics.
The SDK's default raw error logging is disabled for this API. Integrations can
record their own schema issue paths inside their validators; keep values and raw
payloads out of those records. The original `status` remains the control-flow
contract. Diagnostics do not relax validation or trigger automatic retries.

Pass an optional `AbortSignal` as the second argument to `decide()`. Provider SDK
automatic retries are disabled; any future application retry needs a fresh,
explicit budget. Non-cooperative asynchronous tools/streams are raced against
cancellation, and late results do not continue the decision loop. Cleanup is
best-effort; it cannot guarantee remote inference billing stops or an external
side effect is rolled back. Synchronous code that blocks the Node event loop
cannot be preempted by a JavaScript timer: use a worker/process for heavy work.

A deadline bounds waiting, not the probability of receiving a good result.
Measure valid-result rate, median/p95 decision latency and application outcomes
on the actual endpoint. Do not count a timeout as a fast successful decision.

## Release checks

Tests use synthetic states and a loopback model endpoint, never production data.
For publication, inspect staged changes, outgoing commits and the actual packed
archive (including compiled output), and review public PR/release text. Never put
credentials, private endpoints, proprietary assets or application traces into
examples, tests, documentation or package files.
