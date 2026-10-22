import { describe, expect, it } from "vitest";
import { extractMarkdownTables, buildTableSummaryCards, TABLE_CARD_BYTE_LIMIT } from "../final-table-card.ts";

const sample = "| 名称 | 数值 |\n| :--- | ---: |\n| A | 001.20% |";
const tablesIn = (cards: string[]) => cards.flatMap(c => JSON.parse(c).body.elements.filter((e: any) => e.tag === "table"));

describe("final reply table extraction", () => {
  it("accepts short GFM delimiters and blockquoted tables but ignores quoted code", () => {
    expect(extractMarkdownTables("> a | b\n> - | :-:\n> 1 | 2\n\n> ```\n> " + sample.replaceAll("\n", "\n> ") + "\n> ```")[0].rows).toEqual([["1", "2"]]);
  });
  it("keeps table order, headings, empty cells, numeric spelling and links", () => {
    const text = "## 指标\n\n" + sample + "\n\n另一张\n\n链接 | 备注\n--- | ---\n[来源](https://example.com) |\n";
    const tables = extractMarkdownTables(text);
    expect(tables).toHaveLength(2);
    expect(tables[0]).toMatchObject({ title: "指标", headers: ["名称", "数值"], rows: [["A", "001.20%"]], align: ["left", "right"] });
    expect(tables[1].rows).toEqual([["[来源](https://example.com)", ""]]);
  });

  it("supports escaped pipes and inline code containing pipes", () => {
    const [table] = extractMarkdownTables("a | b\n--- | ---\n`x|y` | a\\|b\n``x`|y`` | z");
    expect(table.rows).toEqual([["`x|y`", "a|b"], ["``x`|y``", "z"]]);
  });

  it("ignores fenced and indented code, pipe prose and invalid separators", () => {
    expect(extractMarkdownTables("````md\n" + sample + "\n```\n" + sample + "\n````\n~~~\n" + sample + "\n~~~\n" + sample.split("\n").map(l => "    " + l).join("\n") + "\na | b\n--- | nope\nx | y")).toEqual([]);
  });

  it("preserves extra cells instead of silently dropping them and pads short rows", () => {
    const [table] = extractMarkdownTables("|a|b|\n|---|---|\n|1|2|3|\n|4|");
    expect(table.headers).toHaveLength(3);
    expect(table.rows).toEqual([["1", "2", "3"], ["4", "", ""]]);
  });
});

describe("Feishu table summary cards", () => {
  it("merges tables into one native card without changing numbers", () => {
    const cards = buildTableSummaryCards(sample + "\n\n" + sample);
    expect(cards).toHaveLength(1);
    expect(JSON.parse(cards[0]).schema).toBe("2.0");
    const tables = tablesIn(cards);
    expect(tables).toHaveLength(2);
    expect(tables[0].columns[1]).toMatchObject({ data_type: "markdown", horizontal_align: "right" });
    expect(tables[0].rows).toEqual([{ c0: "A", c1: "001.20%" }]);
  });

  it("does not create a card without a table", () => {
    expect(buildTableSummaryCards("just prose")).toEqual([]);
  });

  it("splits over five components and labels the total card count", () => {
    const cards = buildTableSummaryCards(Array(7).fill(sample).join("\n\n"));
    expect(cards).toHaveLength(2);
    expect(tablesIn(cards)).toHaveLength(7);
    expect(JSON.parse(cards[0]).header.title.content).toContain("1/2");
    for (const card of cards) expect(tablesIn([card]).length).toBeLessThanOrEqual(5);
  });

  it("preserves all columns when a table exceeds the native 50-column limit", () => {
    const headers = Array.from({ length: 57 }, (_, i) => `列${i}`);
    const cards = buildTableSummaryCards(headers.join(" | ") + "\n" + headers.map(() => "---").join(" | ") + "\n" + headers.map((_, i) => `值${i}`).join(" | "));
    const tables = tablesIn(cards);
    expect(tables.every(t => t.columns.length <= 50)).toBe(true);
    expect(tables.flatMap(t => Object.values(t.rows[0]))).toEqual(headers.map((_, i) => `值${i}`));
  });

  it("splits large unicode tables by transport bytes and keeps every row", () => {
    const rows = Array.from({ length: 240 }, (_, i) => [`行${i}`, "中文🙂".repeat(80)]);
    const cards = buildTableSummaryCards("a | b\n--- | ---\n" + rows.map(r => r.join(" | ")).join("\n"));
    expect(cards.length).toBeGreaterThan(1);
    expect(tablesIn(cards).flatMap(t => t.rows.map((r: any) => [r.c0, r.c1]))).toEqual(rows);
    for (const card of cards) expect(Buffer.byteLength(JSON.stringify({ content: card }))).toBeLessThanOrEqual(TABLE_CARD_BYTE_LIMIT);
  });

  it("keeps oversized individual cells and headers in explicitly labelled text continuation cards", () => {
    const value = "中文🙂".repeat(7000);
    const cards = buildTableSummaryCards(`| ${value} |\n| --- |\n| ${value} |`);
    const text = cards.flatMap(c => JSON.parse(c).body.elements).filter(e => e.tag === "div").map(e => e.text.content).join("");
    expect(text).toContain(value);
    expect(text.split(value)).toHaveLength(3);
    for (const card of cards) expect(Buffer.byteLength(JSON.stringify({ content: card }))).toBeLessThanOrEqual(TABLE_CARD_BYTE_LIMIT);
  });
});
