import { describe, expect, it } from "vitest";

import {
  decodeDdgHref,
  extractHtmlTitle,
  htmlToPlainText,
  parseDuckDuckGoHtml,
  webFetchForTool,
  webSearchForTool,
  type FetchLike,
} from "../web-tools.js";

const DDG_HTML = `<!DOCTYPE html>
<html>
<head><title>Search results</title></head>
<body>
  <div class="result results_links results_links_deep web-result">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen%2Fdocs&rut=abc">Node.js <b>Docs</b></a>
    </h2>
    <a rel="nofollow" class="result__snippet" href="//duckduckgo.com/l/?uddg=...">Official documentation for Node.js &amp; npm.</a>
  </div>
  <div class="result">
    <a rel="nofollow" class="result__a" href="https://example.com/page">Example &quot;quoted&quot; page</a>
    <a rel="nofollow" class="result__snippet" href="https://example.com/page">A plain snippet without highlight.</a>
  </div>
</body>
</html>`;

const WEB_FETCH_HTML = `<!DOCTYPE html>
<html><head><title>Fetch &amp; Me</title></head>
<body>
  <style>.x { color: red }</style>
  <script>alert("x")</script>
  <h1>Hello World</h1>
  <p>First paragraph with &amp; entity.</p>
  <p>Second paragraph<br>with a break.</p>
  <footer>bye</footer>
</body></html>`;

describe("parseDuckDuckGoHtml", () => {
  it("extracts title, decoded url, and snippet per result", () => {
    const results = parseDuckDuckGoHtml(DDG_HTML);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: "Node.js Docs",
      url: "https://nodejs.org/en/docs",
      snippet: "Official documentation for Node.js & npm.",
    });
    expect(results[1]).toEqual({
      title: 'Example "quoted" page',
      url: "https://example.com/page",
      snippet: "A plain snippet without highlight.",
    });
  });

  it("returns empty array for pages without results", () => {
    expect(parseDuckDuckGoHtml("<html><body>no results here</body></html>")).toEqual([]);
  });
});

describe("decodeDdgHref", () => {
  it("decodes uddg redirect params and restores protocol", () => {
    expect(
      decodeDdgHref("//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen%2Fdocs&rut=abc"),
    ).toBe("https://nodejs.org/en/docs");
  });

  it("passes through plain urls", () => {
    expect(decodeDdgHref("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
  });

  it("returns input untouched when unparseable", () => {
    expect(decodeDdgHref("not a url")).toBe("not a url");
  });
});

describe("htmlToPlainText", () => {
  it("strips scripts/styles, keeps block boundaries, decodes entities, compresses whitespace", () => {
    const text = htmlToPlainText(WEB_FETCH_HTML);
    expect(text).not.toContain("alert");
    expect(text).not.toContain(".x {");
    expect(text).toContain("Hello World");
    expect(text).toContain("First paragraph with & entity.");
    expect(text).toContain("Second paragraph\nwith a break.");
    expect(text).toContain("bye");
    // 段落间允许单个空行，但不得出现连续空行
    expect(text).not.toContain("\n\n\n");
  });
});

describe("extractHtmlTitle", () => {
  it("extracts and decodes the title", () => {
    expect(extractHtmlTitle(WEB_FETCH_HTML)).toBe("Fetch & Me");
  });

  it("returns empty string when no title", () => {
    expect(extractHtmlTitle("<html><body>x</body></html>")).toBe("");
  });
});

describe("webSearchForTool", () => {
  function mockFetch(html: string, status = 200): FetchLike {
    return async () =>
      new Response(html, {
        status,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
  }

  it("returns parsed results from the search page", async () => {
    const output = await webSearchForTool(
      { query: "nodejs docs" },
      { fetchImpl: mockFetch(DDG_HTML) },
    );
    expect(output.query).toBe("nodejs docs");
    expect(output.results).toHaveLength(2);
    expect(output.results[0].url).toBe("https://nodejs.org/en/docs");
    expect(output.results[0].snippet).toContain("Node.js");
    expect(typeof output.durationMs).toBe("number");
  });

  it("respects maxResults and caps at 10", async () => {
    const html = Array.from({ length: 12 }, (_, i) => {
      const title = `<a rel="nofollow" class="result__a" href="https://e.com/${i}">R${i}</a>`;
      const snippet = `<a rel="nofollow" class="result__snippet" href="https://e.com/${i}">s${i}</a>`;
      return `<div>${title}${snippet}</div>`;
    }).join("");
    const output = await webSearchForTool({ query: "many" }, { fetchImpl: mockFetch(html) });
    expect(output.results).toHaveLength(5);
    expect(output.truncated).toBe(true);

    const output2 = await webSearchForTool({ query: "many", maxResults: 20 }, { fetchImpl: mockFetch(html) });
    expect(output2.results).toHaveLength(10);
  });

  it("returns empty results (not an error) when the page has no matches", async () => {
    const output = await webSearchForTool(
      { query: "zzz-nothing" },
      { fetchImpl: mockFetch("<html><body>no results</body></html>") },
    );
    expect(output.results).toEqual([]);
    expect(output.truncated).toBe(false);
  });

  it("throws on empty query", async () => {
    await expect(webSearchForTool({ query: "  " }, { fetchImpl: mockFetch("") })).rejects.toThrow(
      "query is required",
    );
  });

  it("throws on non-2xx response", async () => {
    await expect(
      webSearchForTool({ query: "x" }, { fetchImpl: mockFetch("blocked", 429) }),
    ).rejects.toThrow("HTTP 429");
  });
});

describe("webFetchForTool", () => {
  function mockFetch(html: string, status = 200, contentType = "text/html; charset=utf-8"): FetchLike {
    return async () =>
      new Response(html, {
        status,
        headers: { "content-type": contentType },
      });
  }

  it("fetches and converts html to plain text with title", async () => {
    const output = await webFetchForTool(
      { url: "https://example.com/page" },
      { fetchImpl: mockFetch(WEB_FETCH_HTML) },
    );
    expect(output.title).toBe("Fetch & Me");
    expect(output.text).toContain("Hello World");
    expect(output.text).toContain("Second paragraph\nwith a break.");
    expect(output.text).not.toContain("alert");
    expect(output.contentType).toContain("text/html");
    expect(output.chars).toBe(output.text.length);
    expect(output.truncated).toBe(false);
  });

  it("truncates text beyond maxChars", async () => {
    const output = await webFetchForTool(
      { url: "https://example.com/long", maxChars: 10 },
      { fetchImpl: mockFetch("<p>hello world and more</p>") },
    );
    expect(output.text).toBe("hello worl");
    expect(output.truncated).toBe(true);
    expect(output.chars).toBe(10);
  });

  it("truncates oversized response bodies", async () => {
    const big = `<!DOCTYPE html><html><body><p>${"a".repeat(600 * 1024)}</p></body></html>`;
    const output = await webFetchForTool(
      { url: "https://example.com/big" },
      { fetchImpl: mockFetch(big) },
    );
    expect(output.truncated).toBe(true);
    expect(output.text.length).toBeLessThan(600 * 1024);
  });

  it("rejects non-http(s) protocols", async () => {
    await expect(
      webFetchForTool({ url: "file:///etc/passwd" }, { fetchImpl: mockFetch("") }),
    ).rejects.toThrow("unsupported protocol");
  });

  it("rejects invalid urls", async () => {
    await expect(
      webFetchForTool({ url: "not a url" }, { fetchImpl: mockFetch("") }),
    ).rejects.toThrow("invalid URL");
  });

  it("throws on missing url and non-2xx", async () => {
    await expect(webFetchForTool({ url: "  " })).rejects.toThrow("url is required");
    await expect(
      webFetchForTool({ url: "https://example.com/404" }, { fetchImpl: mockFetch("nf", 404) }),
    ).rejects.toThrow("HTTP 404");
  });
});
