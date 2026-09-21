import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import {
  agentGrantDir,
  clearAgentCapabilityGrants,
  issueAgentCapabilityGrant,
  revokeAgentCapabilityGrant,
  validateAgentCapabilityGrant,
} from "../agent-capability-grants.ts";

describe("agent capability grants", () => {
  const issued: string[] = [];

  const issue = (sessionId: string): string => {
    issued.push(sessionId);
    return issueAgentCapabilityGrant(sessionId);
  };

  afterEach(() => {
    // revoke 会同时删盘，保证测试之间不残留授权文件。
    for (const sessionId of issued.splice(0)) revokeAgentCapabilityGrant(sessionId);
    clearAgentCapabilityGrants();
  });

  it("authorizes only the session that received the grant", () => {
    const firstGrant = issue("sid-first");
    const secondGrant = issue("sid-second");

    expect(firstGrant).not.toBe(secondGrant);
    expect(validateAgentCapabilityGrant("sid-first", firstGrant)).toBe(true);
    expect(validateAgentCapabilityGrant("sid-second", firstGrant)).toBe(false);
    expect(validateAgentCapabilityGrant("sid-first", secondGrant)).toBe(false);
  });

  it("rejects missing, malformed, and revoked grants", () => {
    const grant = issue("sid-revoked");

    expect(validateAgentCapabilityGrant("sid-revoked", undefined)).toBe(false);
    expect(validateAgentCapabilityGrant("sid-revoked", "not-a-grant")).toBe(false);
    revokeAgentCapabilityGrant("sid-revoked");
    expect(validateAgentCapabilityGrant("sid-revoked", grant)).toBe(false);
  });

  it("persists the grant to disk at issue time", () => {
    const grant = issue("sid-persisted");

    const written = readFileSync(`${agentGrantDir()}/sid-persisted.grant`, "utf8").trim();
    expect(written).toBe(grant);
  });

  it("keeps a grant valid across a process restart", () => {
    const grant = issue("sid-restart");

    clearAgentCapabilityGrants(); // 模拟进程重启：内存清空，磁盘保留

    expect(validateAgentCapabilityGrant("sid-restart", grant)).toBe(true);
    // 重启后必须沿用磁盘上的授权码，而不是重新随机发一个
    expect(issueAgentCapabilityGrant("sid-restart")).toBe(grant);
  });

  it("keeps sessions isolated after a process restart", () => {
    const grantA = issue("sid-restart-a");
    const grantB = issue("sid-restart-b");

    clearAgentCapabilityGrants();

    expect(validateAgentCapabilityGrant("sid-restart-a", grantA)).toBe(true);
    expect(validateAgentCapabilityGrant("sid-restart-b", grantB)).toBe(true);
    expect(validateAgentCapabilityGrant("sid-restart-b", grantA)).toBe(false);
  });

  it("rejects a grant for a session that never received one", () => {
    expect(validateAgentCapabilityGrant("sid-never-issued", "some-grant")).toBe(false);
  });
});
