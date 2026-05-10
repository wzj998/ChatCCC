import { describe, it, expect, beforeEach } from "vitest";
import {
  chatSessionMap,
  sessionInfoMap,
  processedMessages,
  MAX_PROCESSED,
  resetState,
  getSessionStatus,
  getAllSessionsStatus,
} from "../session.ts";

// Helper to create a mock active session entry
function mockActiveSession(chatId: string, overrides: Partial<{
  accumulatedContent: string;
  finalText: string;
  stopped: boolean;
}> = {}) {
  chatSessionMap.set(chatId, {
    gen: 1,
    close: () => {},
    cardId: null,
    stopped: overrides.stopped ?? false,
    accumulatedContent: overrides.accumulatedContent ?? "thinking...",
    finalText: overrides.finalText ?? "",
    spinnerTimer: null,
    msgTimestamp: Date.now(),
    sequence: 0,
    cardBusy: false,
  });
}

function mockSessionInfo(chatId: string, overrides: Partial<{
  sessionId: string;
  turnCount: number;
  lastContextTokens: number;
  startTime: number;
}> = {}) {
  sessionInfoMap.set(chatId, {
    sessionId: overrides.sessionId ?? "test-session-id",
    turnCount: overrides.turnCount ?? 3,
    lastContextTokens: overrides.lastContextTokens ?? 50000,
    startTime: overrides.startTime ?? Date.now(),
    model: "Claude Opus 4.7",
    effort: "high",
  });
}

describe("resetState", () => {
  it("clears all maps and sets", () => {
    chatSessionMap.set("chat1", {
      gen: 1, close: () => {}, cardId: null, stopped: false,
      accumulatedContent: "", finalText: "", spinnerTimer: null,
      msgTimestamp: 0, sequence: 0, cardBusy: false,
    });
    sessionInfoMap.set("chat1", {
      sessionId: "s1", turnCount: 1, lastContextTokens: 0,
      startTime: 0, model: "", effort: "",
    });
    processedMessages.add("msg1");

    resetState();

    expect(chatSessionMap.size).toBe(0);
    expect(sessionInfoMap.size).toBe(0);
    expect(processedMessages.size).toBe(0);
  });
});

describe("getSessionStatus", () => {
  beforeEach(() => {
    chatSessionMap.clear();
    sessionInfoMap.clear();
  });

  it("returns null for unknown chatId", () => {
    expect(getSessionStatus("nonexistent")).toBeNull();
  });

  it("returns status for idle session (info exists, no active session)", () => {
    mockSessionInfo("chat1");
    const status = getSessionStatus("chat1");
    expect(status).not.toBeNull();
    expect(status!.sessionId).toBe("test-session-id");
    expect(status!.running).toBe(false);
    expect(status!.turnCount).toBe(3);
    expect(status!.accumulatedLength).toBe(0);
  });

  it("returns running=true for active session", () => {
    mockSessionInfo("chat1");
    mockActiveSession("chat1", { accumulatedContent: "thinking...", finalText: "reply" });
    const status = getSessionStatus("chat1");
    expect(status!.running).toBe(true);
    expect(status!.accumulatedLength).toBe(16); // "thinking..."(11) + "reply"(5)
  });

  it("returns running=false for stopped session", () => {
    mockSessionInfo("chat1");
    mockActiveSession("chat1", { stopped: true });
    const status = getSessionStatus("chat1");
    expect(status!.running).toBe(false);
  });

  it("returns correct turnCount and other info fields", () => {
    mockSessionInfo("chat1", { turnCount: 7, lastContextTokens: 100000 });
    const status = getSessionStatus("chat1");
    expect(status!.turnCount).toBe(7);
    expect(status!.lastContextTokens).toBe(100000);
  });
});

describe("getAllSessionsStatus", () => {
  beforeEach(() => {
    chatSessionMap.clear();
    sessionInfoMap.clear();
  });

  it("returns empty array when no sessions", () => {
    expect(getAllSessionsStatus()).toEqual([]);
  });

  it("returns statuses for all recorded sessions", () => {
    mockSessionInfo("chat1", { sessionId: "s1" });
    mockSessionInfo("chat2", { sessionId: "s2" });
    mockActiveSession("chat1");
    const result = getAllSessionsStatus();
    expect(result).toHaveLength(2);
    expect(result.find(r => r.chatId === "chat1")!.active).toBe(true);
    expect(result.find(r => r.chatId === "chat2")!.active).toBe(false);
  });

  it("marks stopped sessions as not active", () => {
    mockSessionInfo("chat1");
    mockActiveSession("chat1", { stopped: true });
    const result = getAllSessionsStatus();
    expect(result[0].active).toBe(false);
  });
});

describe("processedMessages dedup", () => {
  it("supports add/has semantics", () => {
    processedMessages.clear();
    processedMessages.add("msg_001");
    expect(processedMessages.has("msg_001")).toBe(true);
    expect(processedMessages.has("msg_002")).toBe(false);
  });

  it("MAX_PROCESSED is defined", () => {
    expect(MAX_PROCESSED).toBe(5000);
  });
});