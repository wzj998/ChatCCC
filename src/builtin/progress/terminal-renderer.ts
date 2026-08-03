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
 *   - 每行按显示宽度截断（CJK/emoji 算 2 列），保证永不折行：一旦折行，
 *     实际占用的屏幕行数会超过 blockLines 计数，下次重绘上移行数不足，
 *     会清掉区块上方的历史内容（用户输入的问题被"吃掉"）。
 *   - end() 时把终态区块定型留在屏幕上（与飞书完成卡片留在消息流语义一致），恢复光标
 */

import { getToolEmoji, truncateContent } from "./cards-helpers.js";
import { progressView, type ProgressToolCall, type ProgressView } from "./view.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

/** 生成中标题后的心跳点号动画帧（1 → 2 → 3 → 2 循环，避免跳变感） */
const ANIM_FRAMES = ["·", "··", "···", "··"];

const ANSI_TOKEN = /\x1b\[[0-9;]*m/;

/** 单个字符在终端里的显示列宽：CJK/emoji 占 2 列，控制符/ZWJ/变体选择符占 0 列 */
export function charWidth(ch: string): number {
  const code = ch.codePointAt(0)!;
  if (code < 32 || (code >= 0x7f && code <= 0xa0)) return 0; // 控制字符
  if (code === 0x200d || code === 0xfe0e || code === 0xfe0f) return 0; // ZWJ / VS15 / VS16
  if (
    (code >= 0x1100 && code <= 0x115f) || // 谚文 Jamo
    (code >= 0x2e80 && code <= 0x303f) || // CJK 部首 / 标点
    (code >= 0x3040 && code <= 0xa4cf) || // 假名 / 汉字 / 谚文 / 彝文
    (code >= 0xac00 && code <= 0xd7a3) || // 谚文音节
    (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容汉字
    (code >= 0xfe30 && code <= 0xfe6f) || // CJK 兼容形式
    (code >= 0xff00 && code <= 0xff60) || // 全角形式
    (code >= 0xffe0 && code <= 0xffe6) || // 全角符号
    (code >= 0x2600 && code <= 0x27bf) || // 杂项符号 + Dingbats（emoji 呈现 2 列）
    (code >= 0x1f000 && code <= 0x1faff)  // emoji 补充区
  ) {
    return 2;
  }
  return 1;
}

/**
 * 按终端显示宽度截断一行（CJK/emoji 计 2 列），ANSI 序列零宽且永不截断。
 * 截断位置若处于未闭合的颜色状态，自动补 \x1b[0m，避免颜色泄漏到后续输出。
 */
export function clipToWidth(s: string, maxCols: number): string {
  if (maxCols <= 0) return "";
  let out = "";
  let visible = 0;
  let colorOpen = false;
  let i = 0;
  while (i < s.length) {
    if (s.charCodeAt(i) === 0x1b) {
      const m = ANSI_TOKEN.exec(s.slice(i));
      if (m && m.index === 0) {
        out += m[0];
        colorOpen = m[0] !== "\x1b[0m";
        i += m[0].length;
        continue;
      }
    }
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const w = charWidth(ch);
    if (visible + w > maxCols) break;
    out += ch;
    visible += w;
    i += ch.length;
  }
  if (colorOpen) out += "\x1b[0m";
  return out;
}

export interface TerminalRendererOptions {
  /** 输出流，默认 process.stdout */
  out?: NodeJS.WritableStream & { columns?: number };
  /** 帧节流毫秒数，默认 66（约 15fps） */
  frameMs?: number;
  /** 生成中心跳动画毫秒数，默认 300；<=0 禁用动画 */
  animMs?: number;
  /** 正文最大行数（超出截断，保留首行+末段） */
  maxBodyLines?: number;
  /** 正文最大字符数 */
  maxBodyChars?: number;
}

function buildStatusLine(view: ProgressView): string {
  switch (view.status) {
    case "done":
      return `${BOLD}${GREEN}✅ 完成${RESET}`;
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
      ? "…"
      : tool.status === "ok"
        ? `${GREEN}✓${RESET}`
        : `${RED}✗${RESET}`;
  const info = tool.status === "running" ? (tool.detail ?? "") : (tool.summary ?? "");
  // 摘要/详情用正常色：最终区块里不出现浅色文字（可读性优先）
  return `  ${emoji} ${tool.name} ${mark} ${info}`;
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
  const clip = (s: string) => clipToWidth(s, width);
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
  private readonly animMs: number;
  private readonly maxBodyLines: number;
  private readonly maxBodyChars: number;
  private view: ProgressView;
  private blockLines = 0;
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  private ended = false;
  private animFrame = 0;
  private animTimer: NodeJS.Timeout | null = null;

  constructor(opts: TerminalRendererOptions = {}) {
    this.out = opts.out ?? process.stdout;
    this.frameMs = opts.frameMs ?? 66;
    this.animMs = opts.animMs ?? 300;
    this.maxBodyLines = opts.maxBodyLines ?? 30;
    this.maxBodyChars = opts.maxBodyChars ?? 12000;
    this.view = progressView();
  }

  /** 开始一轮区块：隐藏光标并渲染首帧，随后启动生成中心跳动画 */
  begin(view: ProgressView): void {
    this.view = view;
    this.out.write(HIDE_CURSOR);
    this.renderNow(view);
    this.startAnimation();
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

  /** 结束一轮：定型终态区块（留在屏幕上），恢复光标，停止动画 */
  end(view: ProgressView): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.stopAnimation();
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
    this.stopAnimation();
    if (!this.ended) {
      this.out.write(SHOW_CURSOR);
    }
  }

  private startAnimation(): void {
    if (this.animMs <= 0 || this.animTimer) return;
    this.animTimer = setInterval(() => {
      this.animFrame++;
      // 终态（done/stopped/error）由 end() 停止；此处兜底跳过，避免结束后还在重绘
      if (this.ended || this.view.status !== "generating") return;
      // 无新事件也持续重绘，点号动画让静止期（思考/工具运行中）也有动态感
      this.renderNow(this.view);
    }, this.animMs);
    this.animTimer.unref?.();
  }

  private stopAnimation(): void {
    if (this.animTimer) {
      clearInterval(this.animTimer);
      this.animTimer = null;
    }
  }

  private renderNow(view: ProgressView): void {
    const width = this.out.columns && this.out.columns > 0 ? this.out.columns : 80;
    const lines = buildBlockLines(this.applyAnimation(view), width, this.maxBodyLines, this.maxBodyChars);
    const newLines = lines.length;

    if (this.blockLines > 0) {
      // 关键：光标此刻停在区块【最后一行】行尾，回到区块第一行只需上移
      // blockLines - 1 行。上移 blockLines 行会每帧多上移 1 行，把区块上方
      // 的历史内容逐行"吃掉"（用户看到的"一行一行往上吃"）。
      this.out.write(`\x1b[${this.blockLines - 1}A`);
      this.out.write("\r");
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

  /** 生成中阶段在标题后叠加心跳点号动画；终态原样返回（buildBlockLines 保持纯函数可测） */
  private applyAnimation(view: ProgressView): ProgressView {
    if (view.status !== "generating") return view;
    const base = view.headerTitle.replace(/\.\.\.\s*$/, "").trim();
    const dots = ANIM_FRAMES[this.animFrame % ANIM_FRAMES.length];
    return { ...view, headerTitle: `${base} ${dots}` };
  }
}
