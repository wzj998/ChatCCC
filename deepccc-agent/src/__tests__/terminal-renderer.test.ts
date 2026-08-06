import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildBlockLines,
  charWidth,
  clipToWidth,
  TerminalProgressRenderer,
} from "../progress/terminal-renderer.js";
import { progressView } from "../progress/view.js";

class FakeOut {
  chunks: string[] = [];
  columns = 100;
  write(s: string): boolean {
    this.chunks.push(s);
    return true;
  }
  get output(): string {
    return this.chunks.join("");
  }
}

/** 测试桩：仅实现 write 的假输出流，类型上按 WritableStream 对待 */
function asOut(out: FakeOut): NodeJS.WritableStream & { columns?: number } {
  return out as unknown as NodeJS.WritableStream & { columns?: number };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("buildBlockLines", () => {
  it("renders generating status line with header title and stop hint", () => {
    const lines = buildBlockLines(
      progressView({ headerTitle: "正在启动 Agent · 0秒", text: "" }),
      100,
    );
    expect(lines[0]).toContain("⏳ 正在启动 Agent · 0秒");
    expect(lines[0]).toContain("Ctrl+C 停止");
    expect(lines[1]).toContain("等待 Agent 输出...");
  });

  it("renders done / stopped / error status lines", () => {
    const done = buildBlockLines(progressView({ status: "done", text: "ok" }), 100);
    expect(done[0]).toContain("✅ 完成");
    expect(done[0]).toContain("\x1b[1m"); // 完成状态行加粗，不用浅色
    const stopped = buildBlockLines(progressView({ status: "stopped", text: "x" }), 100);
    expect(stopped[0]).toContain("⏹ 已停止");
    const error = buildBlockLines(progressView({ status: "error", text: "x" }), 100);
    expect(error[0]).toContain("❌ 异常结束");
  });

  it("renders tool lines with emoji and status mark", () => {
    const lines = buildBlockLines(
      progressView({
        text: "",
        tools: [
          { id: "t1", name: "edit_file", status: "running", detail: "edit a.ts" },
          { id: "t2", name: "run_command", status: "ok", summary: "npm test passed" },
          { id: "t3", name: "search_code", status: "error", summary: "regex error" },
        ],
      }),
      100,
    );
    expect(lines[1]).toContain("edit_file");
    expect(lines[1]).toContain("…");
    expect(lines[1]).toContain("edit a.ts");
    expect(lines[2]).toContain("✓");
    expect(lines[2]).toContain("npm test passed");
    expect(lines[3]).toContain("✗");
    expect(lines[3]).toContain("regex error");
    // 工具行摘要不用浅色字体（回复内容可读性优先）
    for (const line of [lines[1], lines[2], lines[3]]) {
      expect(line).not.toContain("\x1b[2m");
    }
  });

  it("truncates long body to maxBodyLines", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const lines = buildBlockLines(progressView({ text }), 100, 5);
    expect(lines.filter((l) => l.startsWith("line"))).toHaveLength(5);
    expect(lines.join("\n")).toContain("...");
  });

  it("clips lines wider than terminal width to avoid wrapping", () => {
    const lines = buildBlockLines(
      progressView({ text: "x".repeat(200) }),
      30,
    );
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(30);
    }
  });

  it("charWidth counts CJK/emoji as 2 columns and control/ZWJ as 0", () => {
    expect(charWidth("a")).toBe(1);
    expect(charWidth("中")).toBe(2);
    expect(charWidth("📂")).toBe(2);
    expect(charWidth("\u200d")).toBe(0); // ZWJ
  });

  it("clipToWidth truncates by display width, not string length", () => {
    expect(clipToWidth("中文abc", 4)).toBe("中文");
    expect(clipToWidth("中文abc", 5)).toBe("中文a");
    expect(clipToWidth("📂 x", 2)).toBe("📂");
    expect(clipToWidth("📂 x", 3)).toBe("📂 ");
  });

  it("clipToWidth keeps ANSI tokens whole and closes colors at the cut", () => {
    const ansi = "\x1b[32m📂\x1b[0m abc";
    expect(clipToWidth(ansi, 6)).toBe("\x1b[32m📂\x1b[0m abc");
    expect(clipToWidth(ansi, 5)).toBe("\x1b[32m📂\x1b[0m ab");
    // 截断发生在未闭合颜色内时自动补 reset，避免颜色泄漏
    expect(clipToWidth("\x1b[1m\x1b[32m✅ 完成\x1b[0m", 6)).toBe("\x1b[1m\x1b[32m✅ 完\x1b[0m");
  });

  it("emoji tool lines are clipped by display width so the block never wraps", () => {
    // 模拟用户示例：emoji + 超长 JSON 工具行，宽 40 的终端必须整行不折行
    const lines = buildBlockLines(
      progressView({
        text: "",
        tools: [
          { id: "t1", name: "list_dir", status: "ok", summary: `{"path":"C:\\Users\\weizhangjian\\.chatccc","entries":[{"name":"builtin","path":"C:\\Users${'x'.repeat(300)}"}]}` },
        ],
      }),
      40,
    );
    const toolLine = lines.find((l) => l.includes("list_dir"))!;
    // 显示宽度（剥离 ANSI 后按 charWidth 计算）不超过终端列宽，永不折行
    const visible = [...toolLine.replace(/\x1b\[[0-9;]*m/g, "")].reduce((w, ch) => w + charWidth(ch), 0);
    expect(visible).toBeLessThanOrEqual(40);
    expect(toolLine).toContain("\x1b[0m"); // ANSI 完整闭合
  });
});

describe("TerminalProgressRenderer", () => {
  it("begin writes hide-cursor and the first frame", () => {
    const out = new FakeOut();
    const r = new TerminalProgressRenderer({ out: asOut(out) });
    r.begin(progressView({ text: "hello" }));
    expect(out.output.startsWith("\x1b[?25l")).toBe(true);
    expect(out.output).toContain("hello");
    r.dispose();
  });

  it("end finalizes the block and restores cursor, keeping block on screen", () => {
    const out = new FakeOut();
    const r = new TerminalProgressRenderer({ out: asOut(out) });
    r.begin(progressView({ text: "a" }));
    const before = out.chunks.length;
    r.end(progressView({ status: "done", text: "final" }));
    const delta = out.output.slice(out.chunks.slice(0, before).join("").length);
    expect(delta).toContain("✅ 完成");
    expect(delta.endsWith("\x1b[?25h")).toBe(true);
  });

  it("render is frame-throttled and flush forces immediate redraw", () => {
    vi.useFakeTimers();
    const out = new FakeOut();
    const r = new TerminalProgressRenderer({ out: asOut(out), frameMs: 100 });

    r.begin(progressView({ text: "" }));
    const outputAfterBegin = out.output;

    r.render(progressView({ text: "one" }));
    r.render(progressView({ text: "two" }));
    r.render(progressView({ text: "three" }));
    // 节流窗口内多次 render 不应产生任何输出
    expect(out.output).toBe(outputAfterBegin);

    vi.advanceTimersByTime(100);
    // 合并后只重绘一次，且展示的是最新视图
    expect(out.output).toContain("three");
    expect(out.output).not.toContain("two");

    r.flush();
    // flush 立即重绘当前视图（输出继续增长且仍是三帧内容）
    expect(out.output.length).toBeGreaterThan(outputAfterBegin.length);
    expect(out.output).toContain("three");
    r.dispose();
  });

  it("clears leftover lines when the block shrinks", () => {
    const out = new FakeOut();
    const r = new TerminalProgressRenderer({ out: asOut(out) });
    r.begin(progressView({ text: "a\nb\nc\nd" }));
    r.end(progressView({ status: "done", text: "short" }));
    expect(out.output).toContain("\x1b[2K\n");
    expect(out.output).toContain("\x1b[J");
  });

  it("heartbeat animates generating dots so the block never freezes", () => {
    vi.useFakeTimers();
    const out = new FakeOut();
    const r = new TerminalProgressRenderer({ out: asOut(out), animMs: 100 });
    r.begin(progressView({ headerTitle: "生成中...", text: "" }));
    const frame0 = out.output;
    expect(frame0).toContain("·"); // 首帧即带动画点
    vi.advanceTimersByTime(100);
    const frame1 = out.output;
    expect(frame1).not.toBe(frame0); // 无新事件也持续重绘
    expect(frame1).toContain("··"); // 第二帧点号增长
    r.dispose();
  });

  it("stops the heartbeat after end so the final block stays static", () => {
    vi.useFakeTimers();
    const out = new FakeOut();
    const r = new TerminalProgressRenderer({ out: asOut(out), animMs: 100 });
    r.begin(progressView({ text: "" }));
    r.end(progressView({ status: "done", text: "final" }));
    const afterEnd = out.output.length;
    vi.advanceTimersByTime(500);
    expect(out.output.length).toBe(afterEnd);
  });

  it("redraw moves up exactly blockLines-1 rows, never eating history above", () => {
    // 回归测试：光标在区块最后一行时，回到第一行只需上移 N-1 行。
    // 上移 N 行会每帧多上移 1 行，把上方历史内容逐行吃掉。
    const out = new FakeOut();
    const r = new TerminalProgressRenderer({ out: asOut(out), animMs: 0 });
    // 状态行 1 行 + 正文 4 行 = 5 行区块
    r.begin(progressView({ text: "a\nb\nc\nd" }));
    const afterBegin = out.output;
    r.flush(); // 第二帧强制重绘
    const delta = out.output.slice(afterBegin.length);
    expect(delta).toContain("\x1b[4A"); // 上移 5-1=4 行
    expect(delta).not.toContain("\x1b[5A"); // 绝不出现上移 N 行
    r.dispose();
  });

  it("multi-frame redraws keep moving up N-1 rows each time (no drift)", () => {
    const out = new FakeOut();
    const r = new TerminalProgressRenderer({ out: asOut(out), animMs: 0 });
    r.begin(progressView({ text: "a\nb\nc\nd" }));
    for (let i = 0; i < 3; i++) {
      r.flush();
    }
    // 连续多帧重绘，每帧上移都是 4 行（5 行区块），不是 5/6/7... 逐帧递增
    const moves = out.output.match(/\x1b\[(\d+)A/g) ?? [];
    expect(moves.length).toBe(3);
    for (const move of moves) {
      expect(move).toBe("\x1b[4A");
    }
    r.dispose();
  });
});
