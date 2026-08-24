import { randomBytes, timingSafeEqual } from "node:crypto";

const grantsBySession = new Map<string, string>();

export function issueAgentCapabilityGrant(sessionId: string): string {
  if (!sessionId) throw new Error("sessionId is required for an agent capability grant");
  const existing = grantsBySession.get(sessionId);
  if (existing !== undefined) return existing;
  const grant = randomBytes(32).toString("base64url");
  grantsBySession.set(sessionId, grant);
  return grant;
}

export function validateAgentCapabilityGrant(sessionId: string, candidate: unknown): boolean {
  if (!sessionId || typeof candidate !== "string" || candidate.length === 0) return false;
  const expected = grantsBySession.get(sessionId);
  if (expected === undefined) return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const candidateBytes = Buffer.from(candidate, "utf8");
  return expectedBytes.length === candidateBytes.length
    && timingSafeEqual(expectedBytes, candidateBytes);
}

export function clearAgentCapabilityGrants(): void {
  grantsBySession.clear();
}
