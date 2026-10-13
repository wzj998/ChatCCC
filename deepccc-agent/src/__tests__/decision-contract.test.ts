import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { jsonSchema } from "ai";
import { DecisionSession } from "../decision-session.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); } });

describe("DecisionSession wire contract", () => {
  it("sends json_object on the wire and repairs trailing commas without another request", async () => {
    const bodies: any[] = [];
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      bodies.push(JSON.parse(body));
      expect(req.url).toBe('/v1/chat/completions');
      res.writeHead(200, {'content-type':'text/event-stream'});
      const frame = (delta:unknown, finish:string|null) => `data: ${JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:'example-model',choices:[{index:0,delta,finish_reason:finish}]})}\n\n`;
      res.write(frame({role:'assistant',content:'{"action":"wait",'},null));
      res.end(frame({content:'}'},'stop')+'data: [DONE]\n\n');
    });
    servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening');
    const address=server.address() as {port:number};
    const session=new DecisionSession({provider:'openai',apiKey:'test-key',baseURL:`http://127.0.0.1:${address.port}/v1`,model:'example-model'}, {
      outputMode:'json',systemPrompt:'Choose an action.',outputSchema:jsonSchema<{action:string}>({type:'object',properties:{action:{type:'string'}}},{validate:(v:any)=>v?.action==='wait'?{success:true,value:v}:{success:false,error:new Error('Invalid')}}),
    });
    expect(await session.decide({requestId:'json',stateVersion:1,context:{position:1},timeoutMs:2000})).toMatchObject({status:'success',value:{action:'wait'},metrics:{modelCalls:1,jsonRepairs:1}});
    expect(bodies).toHaveLength(1);
    expect(bodies[0].response_format).toEqual({type:'json_object'});
    expect(bodies[0].tools).toBeUndefined();expect(bodies[0].tool_choice).toBeUndefined();
  });
  it("uses a real compatible provider, structured submission and a reusable client", async () => {
    const bodies: any[] = [];
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      bodies.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frame = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "example-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const invalid = body.includes('invalid-example');
      res.write(frame({ role: "assistant", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "submit_result", arguments: invalid ? '{"action":42}' : '{"action":"wait"}' } }] }, null));
      res.end(frame({}, "tool_calls") + "data: [DONE]\n\n");
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as { port: number };
    const session = new DecisionSession({ provider: "openai", apiKey: "test-key", baseURL: `http://127.0.0.1:${address.port}/v1`, model: "example-model", effort: "low" }, {
      systemPrompt: "Select a valid action.",
      outputSchema: jsonSchema<{ action: string }>({ type: "object", properties: { action: { type: "string", enum: ["wait"] } }, required: ["action"], additionalProperties: false }, {
        validate: (v: any) => v?.action === "wait" ? { success: true, value: v } : { success: false, error: new Error("Invalid") },
      }),
    });
    for (const position of [1, 2]) {
      const result = await session.decide({ requestId: `r${position}`, stateVersion: position, context: { position }, timeoutMs: 2000 });
      expect(result).toMatchObject({ status: "success", value: { action: "wait" }, stateVersion: position });
    }
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ model: "example-model", stream: true, tool_choice: "required", reasoning_effort: "low" });
    expect(bodies[0].tools.map((t: any) => t.function.name)).toEqual(["submit_result"]);
    expect(bodies[1].messages.filter((m: any) => m.role === "user")).toEqual([{ role: "user", content: '{"position":2}' }]);
    const invalid = await session.decide({requestId:'invalid-example',stateVersion:3,context:{position:'invalid-example'},timeoutMs:2000});
    expect(invalid).toMatchObject({status:'invalid_output',diagnostic:{code:'tool_input_invalid',stage:'validation'}});
  });
});
