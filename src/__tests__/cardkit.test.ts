import { afterEach, describe, expect, it, vi } from "vitest";

import { updateCardKitCard } from "../cardkit.ts";

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

describe("CardKit request timeout", () => {
  it("serializes concurrent updates and never reuses a sequence after a lost response", async () => {
    let rejectFirst!: (error: Error) => void;
    const sequences: number[] = [];
    vi.stubGlobal("fetch", vi.fn((_url, init) => {
      sequences.push(JSON.parse(init.body).sequence);
      if (sequences.length === 1) return new Promise<Response>((_resolve, reject) => { rejectFirst = reject; });
      return Promise.resolve(new Response(JSON.stringify({ code: 0 })));
    }));
    const first = expect(updateCardKitCard("token", "serialized-card", "{}", 12)).rejects.toThrow("fetch failed");
    const second = updateCardKitCard("token", "serialized-card", "{}", 12);
    await vi.waitFor(() => expect(sequences).toEqual([12]));
    rejectFirst(new Error("fetch failed"));
    await first;
    await second;
    expect(sequences).toEqual([12, 13]);
  });

  it("surfaces a rejected sequence instead of claiming successful delivery", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: 300317, msg: "sequence number compare failed" }))));
    await expect(updateCardKitCard("token", "conflict-card", "{}", 3)).rejects.toThrow("300317");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("aborts a hung card update so display.cardBusy can be released", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});

    const fetchMock = vi.fn((_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(abortError()));
      })
    ));
    vi.stubGlobal("fetch", fetchMock);

    const update = expect(updateCardKitCard("token", "card-1", "{}", 7))
      .rejects.toThrow("updateCard cardId=card-1 seq=7 timeout after 15000ms");
    await vi.advanceTimersByTimeAsync(15_000);

    await update;
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/cardkit/v1/cards/card-1"),
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

    const update = expect(updateCardKitCard("token", "card-2", "{}", 8))
      .rejects.toThrow("updateCard cardId=card-2 seq=8 timeout after 15000ms");
    await vi.advanceTimersByTimeAsync(15_000);

    await update;
  });
});
