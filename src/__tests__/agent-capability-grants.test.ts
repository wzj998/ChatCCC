import { afterEach, describe, expect, it } from "vitest";

import {
  clearAgentCapabilityGrants,
  issueAgentCapabilityGrant,
  validateAgentCapabilityGrant,
} from "../agent-capability-grants.ts";

describe("agent capability grants", () => {
  afterEach(() => clearAgentCapabilityGrants());

  it("authorizes only the session that received the grant", () => {
    const firstGrant = issueAgentCapabilityGrant("sid-first");
    const secondGrant = issueAgentCapabilityGrant("sid-second");

    expect(firstGrant).not.toBe(secondGrant);
    expect(validateAgentCapabilityGrant("sid-first", firstGrant)).toBe(true);
    expect(validateAgentCapabilityGrant("sid-second", firstGrant)).toBe(false);
    expect(validateAgentCapabilityGrant("sid-first", secondGrant)).toBe(false);
  });

  it("rejects missing, malformed, and expired grants", () => {
    const grant = issueAgentCapabilityGrant("sid-first");

    expect(validateAgentCapabilityGrant("sid-first", undefined)).toBe(false);
    expect(validateAgentCapabilityGrant("sid-first", "not-a-grant")).toBe(false);
    clearAgentCapabilityGrants();
    expect(validateAgentCapabilityGrant("sid-first", grant)).toBe(false);
  });
});
