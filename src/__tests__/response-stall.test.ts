import { describe, expect, it } from "vitest";

import {
  hasResponseStalled,
  observeResponseProgress,
} from "../response-stall.ts";

describe("response stall detection", () => {
  it("starts tracking while responding even when the total character count is zero", () => {
    const observation = observeResponseProgress(undefined, true, 0, 1_000);

    expect(observation).toEqual({
      totalChars: 0,
      unchangedSince: 1_000,
    });
  });

  it("auto-ends only after the same character count has lasted three minutes", () => {
    const first = observeResponseProgress(undefined, true, 12, 1_000);
    const unchanged = observeResponseProgress(first, true, 12, 90_000);

    expect(unchanged).toBe(first);
    expect(hasResponseStalled(unchanged, 180_999, 180_000)).toBe(false);
    expect(hasResponseStalled(unchanged, 181_000, 180_000)).toBe(true);
  });

  it("restarts the timer whenever the total character count changes", () => {
    const first = observeResponseProgress(undefined, true, 12, 1_000);
    const changed = observeResponseProgress(first, true, 13, 150_000);

    expect(changed).toEqual({
      totalChars: 13,
      unchangedSince: 150_000,
    });
    expect(hasResponseStalled(changed, 181_000, 180_000)).toBe(false);
  });

  it("restarts the timer for an invisible reasoning heartbeat without changing visible characters", () => {
    const first = observeResponseProgress(undefined, true, 0, 1_000);
    const heartbeat = observeResponseProgress(first, true, 0, 150_000, true);

    expect(heartbeat).toEqual({
      totalChars: 0,
      unchangedSince: 150_000,
    });
    expect(hasResponseStalled(heartbeat, 181_000, 180_000)).toBe(false);
  });

  it("clears tracking outside responding and starts a fresh window after returning", () => {
    const first = observeResponseProgress(undefined, true, 0, 1_000);
    const cleared = observeResponseProgress(first, false, 0, 100_000);
    const resumed = observeResponseProgress(cleared, true, 0, 200_000);

    expect(cleared).toBeUndefined();
    expect(resumed).toEqual({
      totalChars: 0,
      unchangedSince: 200_000,
    });
  });
});
