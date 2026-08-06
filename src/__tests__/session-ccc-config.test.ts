import { afterEach, describe, expect, it, vi } from "vitest";

const createCccAdapterMock = vi.hoisted(() => vi.fn(() => ({
  displayName: "CCC Agent",
  sessionDescPrefix: "CCC Session:",
  createSession: vi.fn(),
  prompt: vi.fn(),
  getSessionInfo: vi.fn(),
  closeSession: vi.fn(),
})));

vi.mock("../adapters/ccc-adapter.ts", () => ({
  createCccAdapter: createCccAdapterMock,
}));

import { config } from "../config.ts";
import { _clearAdapterCacheForTest, getAdapterForTool } from "../session.ts";

describe("CCC Agent ChatCCC configuration", () => {
  const original = { ...config.ccc };

  afterEach(() => {
    Object.assign(config.ccc, original);
    _clearAdapterCacheForTest();
    createCccAdapterMock.mockClear();
  });

  it("injects ChatCCC credentials and endpoint instead of relying on ~/.deepccc", () => {
    Object.assign(config.ccc, {
      DEEPSEEK_API_KEY: "chatccc-api-key",
      DEEPSEEK_BASE_URL: "https://chatccc.example.com/v1",
      model: "chatccc-model",
      effort: "high",
    });

    getAdapterForTool("ccc");

    expect(createCccAdapterMock).toHaveBeenCalledWith({
      apiKey: "chatccc-api-key",
      baseURL: "https://chatccc.example.com/v1",
      model: "chatccc-model",
      effort: "high",
    });
  });
});
