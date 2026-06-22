import { beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../config.ts";
import { getChatGptSubscriptionStatus } from "../chatgpt-subscription.ts";

describe("ChatGPT subscription lookup", () => {
  beforeEach(() => {
    config.chromeDevtools = { enabled: true, port: 15166, chromePath: "" };
  });

  it("returns disabled without probing the port when Chrome CDP is off", async () => {
    config.chromeDevtools = { enabled: false, port: 15166, chromePath: "" };
    const probeChromeCdpImpl = vi.fn();
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(getChatGptSubscriptionStatus({ probeChromeCdpImpl, fetchImpl })).resolves.toMatchObject({
      ok: false,
      code: "chrome_cdp_disabled",
      chromeCdp: { enabled: false, port: 15166, status: "skipped" },
    });
    expect(probeChromeCdpImpl).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns occupied when the configured port is not a healthy Chrome CDP endpoint", async () => {
    await expect(getChatGptSubscriptionStatus({
      probeChromeCdpImpl: vi.fn(async () => "occupied" as const),
    })).resolves.toMatchObject({
      ok: false,
      code: "chrome_cdp_occupied",
      reason: expect.stringContaining("not a healthy Chrome CDP endpoint"),
    });
  });

  it("returns page missing when CDP has no ChatGPT page and cannot create one", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const text = String(url);
      if (text.endsWith("/json/list")) return new Response(JSON.stringify([]), { status: 200 });
      if (text.includes("/json/new?")) return new Response("nope", { status: 500 });
      throw new Error(`unexpected fetch: ${text}`);
    }) as unknown as typeof fetch;

    await expect(getChatGptSubscriptionStatus({
      fetchImpl,
      probeChromeCdpImpl: vi.fn(async () => "healthy" as const),
    })).resolves.toMatchObject({
      ok: false,
      code: "chatgpt_page_missing",
    });
  });

  it("closes only the temporary ChatGPT page created for this lookup", async () => {
    const closed: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const text = String(url);
      if (text.endsWith("/json/list")) return new Response(JSON.stringify([]), { status: 200 });
      if (text.includes("/json/new?")) {
        return new Response(JSON.stringify({
          id: "temp-page",
          type: "page",
          url: "https://chatgpt.com/",
          webSocketDebuggerUrl: "ws://cdp/temp-page",
        }), { status: 200 });
      }
      if (text.endsWith("/json/close/temp-page")) {
        closed.push("temp-page");
        return new Response("Target is closing", { status: 200 });
      }
      throw new Error(`unexpected fetch: ${text}`);
    }) as unknown as typeof fetch;

    await expect(getChatGptSubscriptionStatus({
      fetchImpl,
      probeChromeCdpImpl: vi.fn(async () => "healthy" as const),
      evaluateInPage: vi.fn(async () => ({
        sessionOk: true,
        hasAccessToken: true,
        maskedEmail: "gg***@gmail.com",
        sessionExpires: "2026-09-20T09:30:07.340Z",
        account: {
          status: 200,
          ok: true,
          entitlement: {
            has_active_subscription: true,
            subscription_plan: "chatgptprolite",
            expires_at: "2026-07-12T10:20:11+00:00",
          },
          last_active_subscription: {
            will_renew: false,
            purchase_origin_platform: "chatgpt_web",
          },
        },
      })),
      now: () => new Date("2026-06-22T00:00:00+08:00"),
    })).resolves.toMatchObject({
      ok: true,
      code: "ok",
      subscription: {
        plan: "chatgptprolite",
        expiresAt: "2026-07-12T10:20:11+00:00",
        willRenew: false,
        remainingDays: 21,
      },
    });
    expect(closed).toEqual(["temp-page"]);
  });

  it("does not close an existing ChatGPT page", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const text = String(url);
      if (text.endsWith("/json/list")) {
        return new Response(JSON.stringify([{
          id: "existing-page",
          type: "page",
          url: "https://chatgpt.com/",
          webSocketDebuggerUrl: "ws://cdp/existing-page",
        }]), { status: 200 });
      }
      if (text.includes("/json/close/")) throw new Error("should not close existing page");
      throw new Error(`unexpected fetch: ${text}`);
    }) as unknown as typeof fetch;

    await expect(getChatGptSubscriptionStatus({
      fetchImpl,
      probeChromeCdpImpl: vi.fn(async () => "healthy" as const),
      evaluateInPage: vi.fn(async () => ({
        sessionOk: true,
        hasAccessToken: false,
      })),
    })).resolves.toMatchObject({
      ok: false,
      code: "chatgpt_session_missing",
    });
  });
});
