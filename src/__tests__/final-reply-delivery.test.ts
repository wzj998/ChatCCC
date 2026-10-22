import { describe, expect, it, vi } from "vitest";
import { createFinalReplyDelivery } from "../final-reply-delivery.ts";

const answer = "说明\n\n| a | b |\n| --- | --- |\n| 001 | 25% |";
function fixture() {
  const sent = new Set<string>();
  const deps = {
    isSent: vi.fn(async (s: string, t: number) => sent.has(`${s}:${t}`)),
    markSent: vi.fn(async (s: string, t: number) => { sent.add(`${s}:${t}`); }),
    enabled: () => true,
    sanitize: (text: string) => text,
    warn: vi.fn(),
  };
  const platform = { kind: "feishu", sendText: vi.fn(async (_chat: string, _text: string) => true), sendRawCard: vi.fn(async (_chat: string, _json: string, _options?: { privacyApplied?: boolean }) => true) };
  return { deps, platform, deliver: createFinalReplyDelivery(deps) };
}

describe("terminal reply delivery", () => {
  it("treats legacy void success as success rather than false", async () => {
    const f = fixture();
    f.platform.sendText.mockResolvedValueOnce(undefined as unknown as boolean);
    f.platform.sendRawCard.mockResolvedValueOnce(undefined as unknown as boolean);
    expect(await f.deliver(f.platform, "chat", "s", 1, answer)).toBe(true);
    expect(f.deps.warn).not.toHaveBeenCalled();
  });
  it("sends the unchanged original first, then the merged summary", async () => {
    const f = fixture();
    expect(await f.deliver(f.platform, "chat", "session", 1, answer)).toBe(true);
    expect(f.platform.sendText).toHaveBeenCalledWith("chat", answer);
    expect(f.platform.sendRawCard).toHaveBeenCalledTimes(1);
    expect(f.platform.sendText.mock.invocationCallOrder[0]).toBeLessThan(f.platform.sendRawCard.mock.invocationCallOrder[0]);
  });

  it("deduplicates concurrent finalization, later ticks and persisted delivery after restart", async () => {
    const f = fixture();
    await Promise.all(Array.from({ length: 4 }, () => f.deliver(f.platform, "chat", "session", 1, answer)));
    await createFinalReplyDelivery(f.deps)(f.platform, "chat", "session", 1, answer);
    expect(f.platform.sendText).toHaveBeenCalledTimes(1);
    expect(f.platform.sendRawCard).toHaveBeenCalledTimes(1);
    await f.deliver(f.platform, "chat", "session", 2, answer);
    expect(f.platform.sendRawCard).toHaveBeenCalledTimes(2);
  });

  it.each(["wechat", "unknown"])("does not add summary cards to %s", async kind => {
    const f = fixture(); f.platform.kind = kind;
    await f.deliver(f.platform, "chat", "s", 1, answer);
    expect(f.platform.sendRawCard).not.toHaveBeenCalled();
  });

  it("honors the switch and omits replies without tables", async () => {
    const f = fixture(); f.deps.enabled = () => false;
    await f.deliver(f.platform, "chat", "s", 1, answer);
    f.deps.enabled = () => true;
    await f.deliver(f.platform, "chat", "s", 2, "no tables");
    expect(f.platform.sendRawCard).not.toHaveBeenCalled();
  });

  it("does not send a summary or mark delivery when the original fails; allows retry", async () => {
    const f = fixture(); f.platform.sendText.mockResolvedValueOnce(false);
    expect(await f.deliver(f.platform, "chat", "s", 1, answer)).toBe(false);
    expect(f.platform.sendRawCard).not.toHaveBeenCalled();
    expect(f.deps.markSent).not.toHaveBeenCalled();
    expect(await f.deliver(f.platform, "chat", "s", 1, answer)).toBe(true);
  });

  it.each([false, "throw"])("isolates summary failure (%s) and never resends the original", async failure => {
    const f = fixture();
    f.platform.sendRawCard.mockImplementationOnce(async () => { if (failure === "throw") throw new Error("failed"); return false; });
    expect(await f.deliver(f.platform, "chat", "s", 1, answer)).toBe(true);
    await f.deliver(f.platform, "chat", "s", 1, answer);
    expect(f.platform.sendText).toHaveBeenCalledTimes(1);
    expect(f.deps.warn).toHaveBeenCalled();
  });

  it("sanitizes table contents before constructing JSON, including quote replacements", async () => {
    const f = fixture(); f.deps.sanitize = text => text.replace("001", 'masked"value');
    await f.deliver(f.platform, "chat", "s", 1, answer);
    const card = JSON.parse(f.platform.sendRawCard.mock.calls[0][1]);
    expect(card.body.elements.find((e: any) => e.tag === "table").rows[0].c0).toBe('masked"value');
    expect(f.platform.sendRawCard.mock.calls[0][2]).toEqual({ privacyApplied: true });
  });
});
