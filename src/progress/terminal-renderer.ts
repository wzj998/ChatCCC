/**
 * progress/terminal-renderer.ts — 终端"过程区块"渲染器
 *
 * 把 ProgressView 渲染为终端里的一块固定区域（对应飞书过程卡片）：
 *   - 状态行：生成中 / 完成 / 已停止 / 异常结束
 *   - 工具行：每个工具调用一行（emoji + 名称 + ✓/✗ + 摘要），不再滚屏刷 JSON
 *   - 正文行：模型流式输出，原地更新不滚动
 *
 * 实现要点：
 *   - 隐藏光标（\x1b[?25l）→ 每帧整块重绘（\x1b[{n}A 上移 + \x1b[2K 清行 + \x1b[J 清下方）
 *   - 帧节流合并重绘，避免高频文本增量导致闪烁
 *   - end() 时把终态区块定型留在屏幕上（与飞书完成卡片留在消息流语义一致），恢复光标
 */

import { getToolEmoji, truncateContent } from "../cards.ts";
import { progressView, type ProgressToolCall, type ProgressView } from "./view.ts";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

export interface TerminalRendererOptions {
  /** 输出流，默认 process.stdout */
  out?: NodeJS.WritableStream & { columns?: number };
  /** 帧节流毫秒数，默认 66（约 15fps） */
  frameMs?: number;
  /** 正文最大行数（超出截断，保留首行+末段） */
  maxBodyLines?: number;
  /** 正文最大字符数 */
  maxBodyChars?: number;
}

function buildStatusLine(view: ProgressView): string {
  switch (view.status) {
    case "done":
      return `${GREEN}✅ 完成${RESET}`;
    case "stopped":
      return `${YELLOW}⏹ 已停止${RESET}`;
    case "error":
      return `${RED}❌ 异常结束${RESET}`;
    case "generating": {
      const hint = view.showStop ? `${DIM}  ·  Ctrl+C 停止${RESET}` : "";
      return `⏳ ${view.headerTitle}${hint}`;
    }
  }
}

function buildToolLine(tool: ProgressToolCall): string {
  const emoji = getToolEmoji(tool.name);
  const mark =
    tool.status === "running"
      ? `${DIM}…${RESET}`
      : tool.status === "ok"
        ? `${GREEN}✓${RESET}`
        : `${RED}✗${RESET}`;
  const info = tool.status === "running" ? (tool.detail ?? "") : (tool.summary ?? "");
  return `  ${emoji} ${tool.name} ${mark} ${DIM}${info}${RESET}`;
}

/**
 * 把 ProgressView 展开为区块的完整行列表（不含 ANSI 定位序列，只含内容与颜色）。
 * 单独导出便于单元测试；每行按终端宽度截断，避免长行折行导致行数计数失准。
 */
export function buildBlockLines(
  view: ProgressView,
  width: number,
  maxBodyLines = 30,
  maxBodyChars = 12000,
): string[] {
  const clip = (s: string) => (s.length > width ? s.slice(0, Math.max(0, width - 1)) : s);
  const lines: string[] = [];
  lines.push(clip(buildStatusLine(view)));
  for (const tool of view.tools) {
    lines.push(clip(buildToolLine(tool)));
  }
  const body = truncateContent(view.text, maxBodyLines, maxBodyChars);
  if (body.trim()) {
    for (const line of body.split("\n")) {
      lines.push(clip(line));
    }
  } else {
    lines.push(`${DIM}等待 Agent 输出...${RESET}`);
  }
  return lines;
}

export class TerminalProgressRenderer {
  private readonly out: NodeJS.WritableStream & { columns?: number };
  private readonly frameMs: number;
  private readonly maxBodyLines: number;
  private readonly maxBodyChars: number;
  private view: ProgressView;
  private blockLines = 0;
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  private ended = false;

  constructor(opts: TerminalRendererOptions = {}) {
    this.out = opts.out ?? process.stdout;
    this.frameMs = opts.frameMs ?? 66;
    this.maxBodyLines = opts.maxBodyLines ?? 30;
    this.maxBodyChars = opts.maxBodyChars ?? 12000;
    this.view = progressView();
  }

  /** 开始一轮区块：隐藏光标并渲染首帧 */
  begin(view: ProgressView): void {
    this.view = view;
    this.out.write(HIDE_CURSOR);
    this.renderNow(view);
  }

  /** 标记视图已更新，按帧节流合并重绘（高频增量不闪烁） */
  render(view: ProgressView): void {
    this.view = view;
    if (this.ended) return;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.dirty && !this.ended) {
        this.dirty = false;
        this.renderNow(this.view);
      }
    }, this.frameMs);
  }

  /** 强制立即重绘（工具结果、终态等低频率但需及时反馈的事件） */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.ended) return;
    this.dirty = false;
    this.renderNow(this.view);
  }

  /** 结束一轮：定型终态区块（留在屏幕上），恢复光标 */
  end(view: ProgressView): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.ended = true;
    this.renderNow(view);
    this.out.write(SHOW_CURSOR);
  }

  /** 兜底清理：清除未决定时器并恢复光标 */
  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.ended) {
      this.out.write(SHOW_CURSOR);
    }
  }

  private renderNow(view: ProgressView): void {
    const width = this.out.columns && this.out.columns > 0 ? this.out.columns : 80;
    const lines = buildBlockLines(view, width, this.maxBodyLines, this.maxBodyChars);
    const newLines = lines.length;

    if (this.blockLines > 0) {
      this.out.write(`\x1b[${this.blockLines}A`);
    }
    for (let i = 0; i < lines.length; i++) {
      this.out.write(`\r\x1b[2K${lines[i]}`);
      if (i < lines.length - 1) {
        this.out.write("\n");
      }
    }
    if (newLines < this.blockLines) {
      // 新区块比旧区块短：清掉下方多出的行
      this.out.write("\n");
      for (let i = 0; i < this.blockLines - newLines; i++) {
        this.out.write("\x1b[2K\n");
      }
    }
    this.out.write("\x1b[J");
    this.blockLines = newLines;
  }
}
