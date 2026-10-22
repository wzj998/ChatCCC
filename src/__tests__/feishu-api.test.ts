import { afterEach, describe, expect, it, vi } from "vitest";

import { sendTextReply, sendRawCard } from "../feishu-api.ts";

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

describe("sendTextReply timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps the complete answer and existing table fallback in the original message", async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ code: 0, data: { message_id: "m" } })));
    vi.stubGlobal("fetch", fetchMock);
    const answer = "说明\n\n| 名称 | 数值 |\n| --- | --- |\n| A | 001.20% |\n\n结论";
    expect(await sendTextReply("token", "chat-table", answer)).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    const card = JSON.parse(body.content);
    expect(card.elements[0].content).toBe("说明\n\n```\n| 名称 | 数值 |\n| --- | --- |\n| A | 001.20% |\n```\n\n结论");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("bounds supplementary card sending including body reading (body=%s)", async hangBody => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn((_url: unknown, init?: RequestInit) => {
      const hang = () => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(abortError())));
      return hangBody ? Promise.resolve({ json: hang }) : hang();
    }));
    const result = sendRawCard("token", "chat", '{"schema":"2.0"}', { privacyApplied: true });
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(result).resolves.toBe(false);
  });

  it("aborts a hung text send request", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});

    const fetchMock = vi.fn((_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(abortError()));
      })
    ));
    vi.stubGlobal("fetch", fetchMock);

    const send = expect(sendTextReply("token", "chat-1", "hello"))
      .resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);

    await send;
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/im/v1/messages?receive_id_type=chat_id"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("also aborts when response body reading hangs", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});

    const fetchMock = vi.fn((_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => (
      Promise.resolve({
        status: 200,
        text: () => new Promise<string>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(abortError()));
        }),
      } as Response)
    ));
    vi.stubGlobal("fetch", fetchMock);

    const send = expect(sendTextReply("token", "chat-2", "hello"))
      .resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);

    await send;
  });
});
