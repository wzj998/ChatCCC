import WebSocket from "ws";

import { config } from "./config.ts";
import { probeChromeCdp, type ChromeCdpProbeStatus } from "./chrome-devtools-guard.ts";

const CDP_HOST = "127.0.0.1";
const DEFAULT_CDP_PORT = 15166;
const CDP_TIMEOUT_MS = 10_000;
const CHATGPT_URL = "https://chatgpt.com/";

type FetchLike = typeof fetch;

export type ChatGptSubscriptionCode =
  | "ok"
  | "chrome_cdp_disabled"
  | "chrome_cdp_unreachable"
  | "chrome_cdp_occupied"
  | "chatgpt_page_missing"
  | "chatgpt_session_missing"
  | "chatgpt_subscription_failed";

export interface ChatGptSubscriptionResult {
  ok: boolean;
  code: ChatGptSubscriptionCode;
  reason?: string;
  chromeCdp: {
    enabled: boolean;
    port: number;
    status: ChromeCdpProbeStatus | "skipped";
  };
  chatgpt?: {
    sessionOk: boolean;
    maskedEmail?: string;
    sessionExpiresAt?: string;
  };
  subscription?: {
    active: boolean;
    plan: string | null;
    expiresAt: string | null;
    willRenew: boolean | null;
    purchaseOriginPlatform: string | null;
    remainingDays: number | null;
  };
}

interface ChromeCdpPage {
  id: string;
  type: string;
  title?: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

interface BrowserProbeValue {
  sessionStatus?: number;
  sessionOk?: boolean;
  hasAccessToken?: boolean;
  maskedEmail?: string;
  sessionExpires?: string;
  account?: {
    status: number;
    ok: boolean;
    entitlement: {
      has_active_subscription?: unknown;
      subscription_plan?: unknown;
      expires_at?: unknown;
    } | null;
    last_active_subscription: {
      will_renew?: unknown;
      purchase_origin_platform?: unknown;
    } | null;
    detail?: unknown;
    bodyPrefix?: string;
  };
  error?: string;
}

export interface ChatGptSubscriptionDeps {
  fetchImpl?: FetchLike;
  probeChromeCdpImpl?: typeof probeChromeCdp;
  evaluateInPage?: (webSocketDebuggerUrl: string, expression: string) => Promise<unknown>;
  now?: () => Date;
}

function normalizePort(value: unknown): number {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_CDP_PORT;
}

function cdpBaseUrl(port: number): string {
  return `http://${CDP_HOST}:${port}`;
}

function maskEmail(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.includes("@")) return undefined;
  const [name, domain] = value.split("@");
  if (!name || !domain) return undefined;
  return `${name.slice(0, 2)}***@${domain}`;
}

function calculateRemainingDays(expiresAt: string | null, now: Date): number | null {
  if (!expiresAt) return null;
  const expires = new Date(expiresAt).getTime();
  if (!Number.isFinite(expires)) return null;
  return Math.max(0, Math.ceil((expires - now.getTime()) / 86_400_000));
}

async function fetchJson<T>(url: string, fetchImpl: FetchLike, init?: RequestInit): Promise<T> {
  const response = await fetchImpl(url, init);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json() as T;
}

async function listCdpPages(port: number, fetchImpl: FetchLike): Promise<ChromeCdpPage[]> {
  const pages = await fetchJson<unknown>(`${cdpBaseUrl(port)}/json/list`, fetchImpl);
  return Array.isArray(pages)
    ? pages.flatMap((raw): ChromeCdpPage[] => {
      if (!raw || typeof raw !== "object") return [];
      const page = raw as Partial<ChromeCdpPage>;
      if (typeof page.id !== "string" || typeof page.type !== "string" || typeof page.url !== "string") return [];
      return [{
        id: page.id,
        type: page.type,
        title: typeof page.title === "string" ? page.title : undefined,
        url: page.url,
        webSocketDebuggerUrl: typeof page.webSocketDebuggerUrl === "string" ? page.webSocketDebuggerUrl : undefined,
      }];
    })
    : [];
}

async function createChatGptPage(port: number, fetchImpl: FetchLike): Promise<ChromeCdpPage | null> {
  const url = `${cdpBaseUrl(port)}/json/new?${encodeURIComponent(CHATGPT_URL)}`;
  const response = await fetchImpl(url, { method: "PUT" });
  if (!response.ok) return null;
  const page = await response.json() as Partial<ChromeCdpPage>;
  if (typeof page.id !== "string" || typeof page.webSocketDebuggerUrl !== "string") return null;
  return {
    id: page.id,
    type: typeof page.type === "string" ? page.type : "page",
    title: typeof page.title === "string" ? page.title : undefined,
    url: typeof page.url === "string" ? page.url : CHATGPT_URL,
    webSocketDebuggerUrl: page.webSocketDebuggerUrl,
  };
}

async function closeCdpPage(port: number, pageId: string, fetchImpl: FetchLike): Promise<void> {
  try {
    await fetchImpl(`${cdpBaseUrl(port)}/json/close/${encodeURIComponent(pageId)}`);
  } catch {
    // Closing a temporary tab is best effort and must not change the query result.
  }
}

function subscriptionProbeExpression(): string {
  return `(async()=>{try{const sResp=await fetch('/api/auth/session',{credentials:'include',headers:{Accept:'application/json'}});const sText=await sResp.text();let s=null;try{s=JSON.parse(sText)}catch{}const token=s&&typeof s.accessToken==='string'?s.accessToken:'';const email=s&&s.user&&typeof s.user.email==='string'?s.user.email:'';let account=null;if(token){const r=await fetch('/backend-api/accounts/check/v4-2023-04-27?timezone_offset_min=-480',{credentials:'include',headers:{Accept:'application/json',Authorization:'Bearer '+token}});const text=await r.text();let data=null;try{data=JSON.parse(text)}catch{}const accounts=data&&data.accounts&&typeof data.accounts==='object'?data.accounts:null;const keys=accounts?Object.keys(accounts):[];const acc=accounts&&(accounts.default||accounts[keys[0]]);const ent=acc&&acc.entitlement;const last=acc&&acc.last_active_subscription;account={status:r.status,ok:r.ok,entitlement:ent?{has_active_subscription:ent.has_active_subscription,subscription_plan:ent.subscription_plan,expires_at:ent.expires_at}:null,last_active_subscription:last?{will_renew:last.will_renew,purchase_origin_platform:last.purchase_origin_platform}:null,detail:data&&data.detail?data.detail:undefined,bodyPrefix:data?undefined:text.slice(0,120)};}return {sessionStatus:sResp.status,sessionOk:sResp.ok,hasAccessToken:!!token,maskedEmail:(${maskEmail.toString()})(email),sessionExpires:s&&s.expires,account};}catch(e){return {error:String(e&&e.message||e)}}})()`;
}

async function evaluateInPage(webSocketDebuggerUrl: string, expression: string): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(webSocketDebuggerUrl);
    const id = 1;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("CDP Runtime.evaluate timed out"));
    }, CDP_TIMEOUT_MS);

    ws.on("open", () => {
      ws.send(JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
    });
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as {
        id?: number;
        error?: unknown;
        result?: { result?: { value?: unknown } };
      };
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.close();
      if (msg.error) {
        reject(new Error(JSON.stringify(msg.error)));
      } else {
        resolve(msg.result?.result?.value);
      }
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function failure(
  code: Exclude<ChatGptSubscriptionCode, "ok">,
  reason: string,
  chromeCdp: ChatGptSubscriptionResult["chromeCdp"],
  extra: Partial<ChatGptSubscriptionResult> = {},
): ChatGptSubscriptionResult {
  return { ok: false, code, reason, chromeCdp, ...extra };
}

export function isExpectedSubscriptionFailure(code: ChatGptSubscriptionCode): boolean {
  return code !== "chatgpt_subscription_failed";
}

export async function getChatGptSubscriptionStatus(
  deps: ChatGptSubscriptionDeps = {},
): Promise<ChatGptSubscriptionResult> {
  const cfg = config.chromeDevtools;
  const port = normalizePort(cfg.port);
  const baseChromeCdp = { enabled: cfg.enabled, port };
  const fetchImpl = deps.fetchImpl ?? fetch;

  if (!cfg.enabled) {
    return failure("chrome_cdp_disabled", "Chrome CDP guard is disabled in ChatCCC config.", {
      ...baseChromeCdp,
      status: "skipped",
    });
  }

  const probe = await (deps.probeChromeCdpImpl ?? probeChromeCdp)(port, { fetchImpl });
  const chromeCdp = { ...baseChromeCdp, status: probe };
  if (probe === "unreachable") {
    return failure("chrome_cdp_unreachable", `Chrome CDP endpoint is unreachable on port ${port}.`, chromeCdp);
  }
  if (probe === "occupied") {
    return failure("chrome_cdp_occupied", `Port ${port} is reachable but is not a healthy Chrome CDP endpoint.`, chromeCdp);
  }

  let temporaryPage: ChromeCdpPage | null = null;
  try {
    const existingPages = await listCdpPages(port, fetchImpl);
    let page = existingPages.find((p) =>
      p.type === "page" &&
      p.webSocketDebuggerUrl &&
      p.url.startsWith(CHATGPT_URL)
    ) ?? null;
    if (!page) {
      temporaryPage = await createChatGptPage(port, fetchImpl);
      page = temporaryPage;
    }
    if (!page?.webSocketDebuggerUrl) {
      return failure("chatgpt_page_missing", "No usable chatgpt.com page is available from Chrome CDP.", chromeCdp);
    }

    const raw = await (deps.evaluateInPage ?? evaluateInPage)(page.webSocketDebuggerUrl, subscriptionProbeExpression()) as BrowserProbeValue;
    if (!raw || typeof raw !== "object") {
      return failure("chatgpt_subscription_failed", "Chrome CDP returned an empty subscription probe result.", chromeCdp);
    }
    if (raw.error) {
      return failure("chatgpt_subscription_failed", raw.error, chromeCdp);
    }

    const chatgpt = {
      sessionOk: raw.sessionOk === true,
      maskedEmail: raw.maskedEmail || undefined,
      sessionExpiresAt: typeof raw.sessionExpires === "string" ? raw.sessionExpires : undefined,
    };
    if (!raw.hasAccessToken) {
      return failure("chatgpt_session_missing", "ChatGPT browser session has no access token.", chromeCdp, { chatgpt });
    }
    if (!raw.account?.ok || !raw.account.entitlement) {
      return failure(
        "chatgpt_subscription_failed",
        `ChatGPT account check failed${raw.account?.status ? ` with HTTP ${raw.account.status}` : ""}.`,
        chromeCdp,
        { chatgpt },
      );
    }

    const entitlement = raw.account.entitlement;
    const last = raw.account.last_active_subscription;
    const expiresAt = typeof entitlement.expires_at === "string" ? entitlement.expires_at : null;
    return {
      ok: true,
      code: "ok",
      chromeCdp,
      chatgpt,
      subscription: {
        active: entitlement.has_active_subscription === true,
        plan: typeof entitlement.subscription_plan === "string" ? entitlement.subscription_plan : null,
        expiresAt,
        willRenew: typeof last?.will_renew === "boolean" ? last.will_renew : null,
        purchaseOriginPlatform: typeof last?.purchase_origin_platform === "string" ? last.purchase_origin_platform : null,
        remainingDays: calculateRemainingDays(expiresAt, deps.now?.() ?? new Date()),
      },
    };
  } catch (err) {
    return failure("chatgpt_subscription_failed", (err as Error).message, chromeCdp);
  } finally {
    if (temporaryPage) {
      await closeCdpPage(port, temporaryPage.id, fetchImpl);
    }
  }
}
