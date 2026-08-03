import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildBlockLines,
  TerminalProgressRenderer,
} from "../progress/terminal-renderer.ts";
import { progressView } from "../progress/view.ts";

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
});

describe("TerminalProgressRenderer", () => {
  it("begin writes hide-cursor and the first frame", () => {
    const out = new FakeOut();
    const r = new TerminalProgressRenderer({ out: asOut(out) });
    r.begin(progressView({ text: "hello" }));
    expect(out.output.startsWith("\x1b[?25l")).toBe(true);
    expect(out.output).toContain("hello");
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
});
