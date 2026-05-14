import { describe, expect, it } from "vitest";

import {
  AGENT_SEND_IMAGE_PATH,
  buildAgentImageCapabilityPrompt,
} from "../agent-image-rpc.ts";

describe("agent image RPC", () => {
  it("builds prompt instructions with session_id", () => {
    const prompt = buildAgentImageCapabilityPrompt({
      url: `http://127.0.0.1:18080${AGENT_SEND_IMAGE_PATH}`,
      sessionId: "sid-test",
    });

    expect(prompt).toContain("POST http://127.0.0.1:18080/api/agent/send-image");
    expect(prompt).toContain('"session_id":"sid-test"');
    expect(prompt).toContain("Content-Type: application/json; charset=utf-8");
    expect(prompt).toContain("UTF-8 encoded JSON bytes");
    expect(prompt).toContain('"path"');
    expect(prompt).not.toContain("Authorization: Bearer");
    expect(prompt).not.toContain("CHATCCC_SEND_IMAGE_URL");
    expect(prompt).not.toContain("CHATCCC_SEND_IMAGE_TOKEN");
  });

  it("builds prompt with cwd hint", () => {
    const prompt = buildAgentImageCapabilityPrompt({
      url: `http://127.0.0.1:18080${AGENT_SEND_IMAGE_PATH}`,
      sessionId: "sid-1",
      cwd: "F:/repo",
    });

    expect(prompt).toContain("Current working directory: F:/repo");
  });
});