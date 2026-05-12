import { describe, expect, it } from "vitest";

import {
  AGENT_SEND_IMAGE_PATH,
  buildAgentImageCapabilityPrompt,
  createAgentImageGrant,
  getAgentImageGrantFromAuthorization,
  revokeAgentImageGrant,
} from "../agent-image-rpc.ts";

describe("agent image RPC grants", () => {
  it("creates a per-turn grant and validates bearer authorization", () => {
    const grant = createAgentImageGrant({
      chatId: "oc_chat",
      sessionId: "sid-1",
      cwd: "F:/repo",
      port: 18080,
      nowMs: 1000,
      ttlMs: 60_000,
    });

    expect(grant.url).toBe(`http://127.0.0.1:18080${AGENT_SEND_IMAGE_PATH}`);
    expect(grant.token.length).toBeGreaterThan(20);

    const found = getAgentImageGrantFromAuthorization(
      `Bearer ${grant.token}`,
      30_000,
    );
    expect(found).toMatchObject({
      chatId: "oc_chat",
      sessionId: "sid-1",
      cwd: "F:/repo",
    });

    revokeAgentImageGrant(grant.token);
    expect(getAgentImageGrantFromAuthorization(`Bearer ${grant.token}`, 30_000)).toBeNull();
  });

  it("rejects missing, malformed, revoked, and expired authorization", () => {
    const grant = createAgentImageGrant({
      chatId: "oc_chat",
      sessionId: "sid-1",
      cwd: "F:/repo",
      port: 18080,
      nowMs: 1000,
      ttlMs: 10,
    });

    expect(getAgentImageGrantFromAuthorization("", 1000)).toBeNull();
    expect(getAgentImageGrantFromAuthorization(grant.token, 1000)).toBeNull();
    expect(getAgentImageGrantFromAuthorization(`Basic ${grant.token}`, 1000)).toBeNull();
    expect(getAgentImageGrantFromAuthorization(`Bearer ${grant.token}`, 1011)).toBeNull();
  });

  it("builds prompt instructions without requiring environment variables", () => {
    const prompt = buildAgentImageCapabilityPrompt({
      url: `http://127.0.0.1:18080${AGENT_SEND_IMAGE_PATH}`,
      token: "tok_test",
    });

    expect(prompt).toContain("POST http://127.0.0.1:18080/api/agent/send-image");
    expect(prompt).toContain("Authorization: Bearer tok_test");
    expect(prompt).toContain("\"path\"");
    expect(prompt).not.toContain("CHATCCC_SEND_IMAGE_URL");
    expect(prompt).not.toContain("CHATCCC_SEND_IMAGE_TOKEN");
  });
});
