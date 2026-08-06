/**
 * web-tools.ts — websearch / webfetch 内置工具（agent 端联网，业界主流做法）
 *
 * 与 Claude Code 的 WebSearch/WebFetch、Codex 的 web search 相同形态：
 * 模型通过 function calling 调用，agent 进程执行 HTTP 请求，结果回填上下文。
 * 两者都是只读外部网络操作，不触碰本地文件系统，无需权限询问。
 *
 * - websearch：DuckDuckGo HTML 端点（免 API key），返回标题 + URL + 摘要
 * - webfetch：HTTP GET + HTML 转纯文本，控制大小与超时
 *
 * 零新依赖：使用 Node 20 内置 fetch / AbortSignal / Buffer。
 * 解析逻辑拆成纯函数导出，便于单测；fetch 可通过 options 注入 mock。
 */

export interface WebSearchInput {
  query: string;
  /** 返回结果条数上限，默认 5，上限 10 */
  maxResults?: number;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchOutput {
  query: string;
  results: WebSearchResult[];
  truncated: boolean;
  durationMs: number;
}

export interface WebFetchInput {
  url: string;
  /** 返回纯文本字符数上限，默认 10000，上限 100000 */
  maxChars?: number;
}

export interface WebFetchOutput {
  url: string;
  contentType: string;
  title: string;
  text: string;
  chars: number;
  truncated: boolean;
  durationMs: number;
}

export const WEB_SEARCH_TIMEOUT_MS = 15_000;
export const WEB_FETCH_TIMEOUT_MS = 20_000;
export const WEB_SEARCH_DEFAULT_RESULTS = 5;
export const WEB_SEARCH_MAX_RESULTS = 10;
export const WEB_FETCH_DEFAULT_CHARS = 10_000;
export const WEB_FETCH_MAX_CHARS = 100_000;
/** webfetch 读取响应体的大小上限（超出即截断），防止把整个大文件拉进上下文 */
export const WEB_FETCH_MAX_BYTES = 512 * 1024;

const SEARCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface WebToolOptions {
  abortSignal?: AbortSignal;
  /** 测试注入用，默认全局 fetch */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

function normalizeMaxResults(value: number | undefined): number {
  if (value === undefined) return WEB_SEARCH_DEFAULT_RESULTS;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("maxResults must be a positive integer when provided");
  }
  return Math.min(value, WEB_SEARCH_MAX_RESULTS);
}

function normalizeMaxChars(value: number | undefined): number {
  if (value === undefined) return WEB_FETCH_DEFAULT_CHARS;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("maxChars must be a positive integer when provided");
  }
  return Math.min(value, WEB_FETCH_MAX_CHARS);
}

function buildSignal(timeoutMs: number, abortSignal?: AbortSignal): AbortSignal {
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (abortSignal) signals.push(abortSignal);
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, n: string) => {
      try {
        return String.fromCodePoint(Number(n));
      } catch {
        return "";
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => {
      try {
        return String.fromCodePoint(parseInt(h, 16));
      } catch {
        return "";
      }
    })
    .replace(/&amp;/gi, "&");
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

/** 提取 <title> 文本（用于 webfetch 结果），无则返回空字符串 */
export function extractHtmlTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? stripTags(m[1]) : "";
}

/**
 * HTML 转纯文本：
 * 去掉 script/style/noscript/svg/注释 → 块级元素补换行 → 去标签 → 解实体 → 压缩空白。
 */
export function htmlToPlainText(html: string): string {
  let text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|pre|blockquote|section|article|table|ul|ol|header|footer|nav|dl|dd|dt)>/gi, "\n")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  text = decodeEntities(text);

  return text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line, i, arr) => line !== "" || (i > 0 && arr[i - 1] !== ""))
    .join("\n")
    .trim();
}

/** 解码 DuckDuckGo 结果链接：/l/?uddg=<encoded> 还原为目标 URL */
export function decodeDdgHref(href: string): string {
  let h = href.trim();
  if (h.startsWith("//")) h = "https:" + h;
  try {
    const u = new URL(h);
    if (u.hostname === "duckduckgo.com" && u.pathname.startsWith("/l/")) {
      const uddg = u.searchParams.get("uddg");
      if (uddg) return decodeURIComponent(uddg);
    }
    return u.toString();
  } catch {
    return h;
  }
}

/**
 * 解析 DuckDuckGo HTML 搜索结果页（html.duckduckgo.com/html）。
 * 提取 result__a（标题 + href）与 result__snippet（摘要）。
 */
export function parseDuckDuckGoHtml(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const titleRe = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const titleMatches = [...html.matchAll(titleRe)];
  const snippetMatches = [...html.matchAll(snippetRe)];

  titleMatches.forEach((m, i) => {
    const title = stripTags(m[2]);
    const url = decodeDdgHref(m[1]);
    const snippet = snippetMatches[i] ? stripTags(snippetMatches[i][1]) : "";
    if (!title && !url) return;
    results.push({ title, url, snippet });
  });

  return results;
}

/** 读取响应体并限制字节数（超出截断），避免整页大文件进入上下文 */
async function readBodyWithLimit(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) {
    const text = await res.text();
    return { text, truncated: Buffer.byteLength(text, "utf8") > maxBytes };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total + value.byteLength > maxBytes) {
      const remaining = maxBytes - total;
      if (remaining > 0) chunks.push(value.subarray(0, remaining));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return { text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8"), truncated };
}

/**
 * websearch：DuckDuckGo HTML 搜索（免 API key），返回标题 + URL + 摘要。
 * 网络失败抛错（成为 tool-error），搜索无结果返回空数组（不是错误）。
 */
export async function webSearchForTool(
  input: WebSearchInput,
  options: WebToolOptions = {},
): Promise<WebSearchOutput> {
  const query = input.query?.trim();
  if (!query) throw new Error("query is required");

  const maxResults = normalizeMaxResults(input.maxResults);
  const startedAt = Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  const res = await fetchImpl(url, {
    headers: {
      "User-Agent": SEARCH_UA,
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
    signal: buildSignal(options.timeoutMs ?? WEB_SEARCH_TIMEOUT_MS, options.abortSignal),
  });
  if (!res.ok) {
    throw new Error(`web search failed: HTTP ${res.status} ${res.statusText}`);
  }

  const { text } = await readBodyWithLimit(res, WEB_FETCH_MAX_BYTES);
  const all = parseDuckDuckGoHtml(text);
  const results = all.slice(0, maxResults);

  return {
    query,
    results,
    truncated: all.length > results.length,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * webfetch：HTTP GET + HTML 转纯文本。
 * 只允许 http/https（防 file:// 等本地协议），非 2xx 抛错。
 */
export async function webFetchForTool(
  input: WebFetchInput,
  options: WebToolOptions = {},
): Promise<WebFetchOutput> {
  const raw = input.url?.trim();
  if (!raw) throw new Error("url is required");

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`invalid URL: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`unsupported protocol: ${parsed.protocol} (only http/https allowed)`);
  }

  const maxChars = normalizeMaxChars(input.maxChars);
  const startedAt = Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;

  const res = await fetchImpl(parsed.toString(), {
    headers: {
      "User-Agent": SEARCH_UA,
      Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
    signal: buildSignal(options.timeoutMs ?? WEB_FETCH_TIMEOUT_MS, options.abortSignal),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${parsed.toString()}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  const { text: body, truncated: bodyTruncated } = await readBodyWithLimit(res, WEB_FETCH_MAX_BYTES);
  const title = extractHtmlTitle(body);
  const plain = htmlToPlainText(body);
  const text = plain.length > maxChars ? plain.slice(0, maxChars) : plain;

  return {
    url: parsed.toString(),
    contentType,
    title,
    text,
    chars: text.length,
    truncated: bodyTruncated || plain.length > maxChars,
    durationMs: Date.now() - startedAt,
  };
}
