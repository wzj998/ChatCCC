/** Protocol JSON mode without client-side parsing of partial objects. */
export function jsonObjectFetch(transport: typeof fetch = globalThis.fetch): typeof fetch {
  return async (input, init) => {
    if (typeof init?.body !== "string") throw new Error("JSON mode requires a serialized request body");
    const body = JSON.parse(init.body);
    return transport(input, {
      ...init,
      body: JSON.stringify({...body, response_format: {type: "json_object"}}),
    });
  };
}
