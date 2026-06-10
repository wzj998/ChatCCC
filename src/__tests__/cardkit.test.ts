import { afterEach, describe, expect, it, vi } from "vitest";

import { updateCardKitCard } from "../cardkit.ts";

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

describe("CardKit request timeout", () => {
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
