import { describe, expect, it } from "vitest";

import { createCtrlCState } from "../builtin/sigint.ts";

describe("builtin CLI Ctrl+C state", () => {
  it("requires two presses to interrupt an active generation", () => {
    let now = 1_000;
    const state = createCtrlCState({ windowMs: 2_000, now: () => now });

    expect(state.press(true)).toBe("arm-interrupt");
    expect(state.press(true)).toBe("interrupt");
  });

  it("requires two presses to exit while idle", () => {
    let now = 1_000;
    const state = createCtrlCState({ windowMs: 2_000, now: () => now });

    expect(state.press(false)).toBe("arm-exit");
    expect(state.press(false)).toBe("exit");
  });

  it("expires the pending confirmation after the window", () => {
    let now = 1_000;
    const state = createCtrlCState({ windowMs: 2_000, now: () => now });

    expect(state.press(true)).toBe("arm-interrupt");

    now += 2_001;

    expect(state.press(true)).toBe("arm-interrupt");
    expect(state.press(true)).toBe("interrupt");
  });

  it("does not convert a pending interrupt into an idle exit after reset", () => {
    let now = 1_000;
    const state = createCtrlCState({ windowMs: 2_000, now: () => now });

    expect(state.press(true)).toBe("arm-interrupt");

    state.reset();
    now += 1_000;

    expect(state.press(false)).toBe("arm-exit");
  });

  it("does not confirm a different action with the second press", () => {
    let now = 1_000;
    const state = createCtrlCState({ windowMs: 2_000, now: () => now });

    expect(state.press(true)).toBe("arm-interrupt");
    now += 500;

    expect(state.press(false)).toBe("arm-exit");
    expect(state.press(false)).toBe("exit");
  });
});
