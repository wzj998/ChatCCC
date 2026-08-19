import { describe, expect, it } from "vitest";

import { DEEPCCC_WEB_PAGE } from "../web-page.js";

function renderer(): (value: string) => string {
  const script = DEEPCCC_WEB_PAGE.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  const start = script.indexOf("function escapeHtml");
  const end = script.indexOf("function statusText", start);
  if (start < 0 || end < 0) throw new Error("DeepCCC markdown renderer not found");
  const source = script.slice(start, end);
  return new Function(`${source}; return markdown;`)() as (value: string) => string;
}

describe("DeepCCC Web markdown", () => {
  it("renders headings, lists, quotes, links, and horizontal rules", () => {
    const markdown = renderer();
    const html = markdown([
      "## 标题",
      "",
      "- 第一项",
      "- 第二项",
      "",
      "> 引用",
      "",
      "[链接](https://example.com)",
      "",
      "---",
    ].join("\n"));

    expect(html).toContain("<h2>标题</h2>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<blockquote><p>引用</p></blockquote>");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("<hr>");
  });

  it("renders GitHub-style tables while preserving inline formatting", () => {
    const markdown = renderer();
    const html = markdown([
      "| 名称 | 状态 |",
      "| :--- | ---: |",
      "| **DeepCCC** | `ready` |",
    ].join("\n"));

    expect(html).toContain("<table>");
    expect(html).toContain('style="text-align:left"');
    expect(html).toContain('style="text-align:right"');
    expect(html).toContain("<strong>DeepCCC</strong>");
    expect(html).toContain("<code>ready</code>");
  });

  it("keeps code blocks literal and escapes unsafe HTML", () => {
    const markdown = renderer();
    const html = markdown("```html\n<h1>raw</h1>\n```\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))");

    expect(html).toContain("&lt;h1&gt;raw&lt;/h1&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('href="#"');
  });
});
