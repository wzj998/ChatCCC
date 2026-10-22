/** Native Feishu tables for terminal replies. No model calls or numeric coercion.
 * Schema/limits: https://open.feishu.cn/document/feishu-cards/card-json-v2-components/content-components/table
 */
export interface ReplyTable {
  title: string;
  headers: string[];
  align: Array<"left" | "center" | "right">;
  rows: string[][];
}

// Leave headroom below the IM message limit, counting the JSON-escaped content too.
export const TABLE_CARD_BYTE_LIMIT = 24_000;

function cells(line: string): string[] | null {
  const text = line.trim();
  const parts: string[] = [];
  let cell = "";
  let ticks = 0;
  let separators = 0;
  let lastWasSeparator = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      // Escaped pipes are content. Preserve all other Markdown escapes.
      const next = text[++i];
      cell += next === "|" ? "|" : "\\" + next;
      lastWasSeparator = false;
    } else if (ch === "`") {
      let end = i + 1;
      while (text[end] === "`") end++;
      const count = end - i;
      if (ticks === count) ticks = 0;
      else if (!ticks && text.indexOf("`".repeat(count), end) >= 0) ticks = count;
      cell += text.slice(i, end);
      i = end - 1;
      lastWasSeparator = false;
    } else if (ch === "|" && !ticks) {
      parts.push(cell.trim()); cell = ""; separators++;
      lastWasSeparator = true;
    } else {
      cell += ch;
      lastWasSeparator = false;
    }
  }
  if (!separators) return null;
  parts.push(cell.trim());
  if (text.startsWith("|")) parts.shift();
  if (lastWasSeparator) parts.pop();
  return parts.length ? parts : null;
}

export function extractMarkdownTables(text: string): ReplyTable[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map(line => line.replace(/^(?: {0,3}> ?)+/, ""));
  const usable: boolean[] = [];
  let fence: { char: string; length: number } | undefined;
  for (const line of lines) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      usable.push(false);
      if (match && match[1][0] === fence.char && match[1].length >= fence.length && !match[2].trim()) fence = undefined;
    } else if (match) {
      fence = { char: match[1][0], length: match[1].length };
      usable.push(false);
    } else usable.push(!/^( {4}|\t)/.test(line));
  }
  const tables: ReplyTable[] = [];
  let heading = "";
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!usable[i]) continue;
    const h = /^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/.exec(lines[i]);
    if (h) heading = h[1];
    if (!usable[i + 1]) continue;
    const headers = cells(lines[i]);
    const separator = cells(lines[i + 1]);
    if (!headers || !separator || headers.length !== separator.length || !separator.every(c => /^:?-+:?$/.test(c))) continue;
    const align = separator.map((c): "left" | "center" | "right" => c.endsWith(":") ? c.startsWith(":") ? "center" : "right" : "left");
    const rows: string[][] = [];
    let end = i + 2;
    while (end < lines.length && usable[end] && lines[end].trim()) {
      const row = cells(lines[end]);
      if (!row) break;
      // A new header + delimiter starts a separate adjacent table.
      const next = usable[end + 1] ? cells(lines[end + 1] ?? "") : null;
      if (next?.length === row.length && next.every(c => /^:?-+:?$/.test(c))) break;
      rows.push(row); end++;
    }
    const width = Math.max(headers.length, ...rows.map(r => r.length));
    while (headers.length < width) { headers.push(`列 ${headers.length + 1}（无表头）`); align.push("left"); }
    for (const row of rows) while (row.length < width) row.push("");
    tables.push({ title: heading, headers, align, rows });
    i = end - 1;
  }
  return tables;
}

type Element = Record<string, unknown>;
type Part = { elements: Element[]; tables: number };

function card(elements: Element[], title: string) {
  return { schema: "2.0", config: { update_multi: true }, header: { template: "blue", title: { tag: "plain_text", content: title } }, body: { elements } };
}
function transportBytes(elements: Element[]): number {
  return Buffer.byteLength(JSON.stringify({ content: JSON.stringify(card(elements, "表格汇总（999999/999999）")) }), "utf8");
}
const labelElement = (content: string): Element => ({ tag: "div", text: { tag: "plain_text", content } });

/** Split dimensions first; a single huge cell falls back to labelled plain-text continuations. */
function* tableParts(table: ReplyTable, number: number, r0 = 0, r1 = table.rows.length, c0 = 0, c1 = table.headers.length): Generator<Part> {
  if (c1 - c0 > 50) {
    for (let col = c0; col < c1; col += 50) yield* tableParts(table, number, r0, r1, col, Math.min(col + 50, c1));
    return;
  }
  const label = `表格 ${number}${table.title ? ` · ${table.title.slice(0, 160)}` : ""}（行 ${r1 ? r0 + 1 : 0}–${r1}/${table.rows.length}，列 ${c0 + 1}–${c1}/${table.headers.length}）`;
  const elements = [labelElement(label), {
    // Keep every column in the same scrolling region. Frozen first columns can
    // drift vertically on mobile when a neighbouring header wraps to two lines.
    tag: "table", page_size: 10, row_height: "auto", row_max_height: "200px", freeze_first_column: false,
    header_style: { bold: true, background_style: "grey", lines: 2 },
    columns: table.headers.slice(c0, c1).map((h, i) => ({ name: `c${i + c0}`, display_name: h, data_type: "markdown", width: "auto", vertical_align: "top", horizontal_align: table.align[i + c0] })),
    rows: table.rows.slice(r0, r1).map(row => Object.fromEntries(row.slice(c0, c1).map((v, i) => [`c${i + c0}`, v]))),
  }];
  if (transportBytes(elements) <= TABLE_CARD_BYTE_LIMIT) { yield { elements, tables: 1 }; return; }
  if (r1 - r0 > 1) {
    const mid = Math.floor((r0 + r1) / 2);
    yield* tableParts(table, number, r0, mid, c0, c1);
    yield* tableParts(table, number, mid, r1, c0, c1);
  } else if (c1 - c0 > 1) {
    const mid = Math.floor((c0 + c1) / 2);
    yield* tableParts(table, number, r0, r1, c0, mid);
    yield* tableParts(table, number, r0, r1, mid, c1);
  } else {
    // Plain text does not break a very long Markdown link into invalid link markup.
    const full = `${table.headers[c0]}\n${r1 ? table.rows[r0][c0] : ""}`;
    const chars = Array.from(full);
    for (let start = 0; start < chars.length; start += 2500) {
      yield { tables: 0, elements: [
        { tag: "markdown", content: `${label} · 超长单元格，完整文本续页 ${Math.floor(start / 2500) + 1}` },
        labelElement(chars.slice(start, start + 2500).join("")),
      ] };
    }
  }
}

export function buildTableSummaryCards(text: string): string[] {
  const groups: Element[][] = [];
  let elements: Element[] = [];
  let tableCount = 0;
  for (const [index, table] of extractMarkdownTables(text).entries()) {
    for (const part of tableParts(table, index + 1)) {
      if (elements.length && (tableCount + part.tables > 5 || elements.length + part.elements.length > 180 || transportBytes([...elements, ...part.elements]) > TABLE_CARD_BYTE_LIMIT)) {
        groups.push(elements); elements = []; tableCount = 0;
      }
      elements.push(...part.elements); tableCount += part.tables;
    }
  }
  if (elements.length) groups.push(elements);
  return groups.map((group, i) => JSON.stringify(card(group, groups.length > 1 ? `表格汇总（${i + 1}/${groups.length}）` : "表格汇总")));
}
