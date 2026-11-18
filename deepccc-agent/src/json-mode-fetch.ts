/** Protocol JSON mode without client-side parsing of partial objects. */
export function jsonObjectFetch(transport: typeof fetch = globalThis.fetch, provider: 'openai' | 'openai-responses' = 'openai'): typeof fetch {
  return async (input, init) => {
    if (typeof init?.body !== "string") throw new Error("JSON mode requires a serialized request body");
    const body = JSON.parse(init.body);
    return transport(input, {
      ...init,
      body: JSON.stringify(provider === 'openai-responses'
        ? {...body, text: {...body.text, format: {type: 'json_object'}}}
        : {...body, response_format: {type: "json_object"}}),
    });
  };
}
