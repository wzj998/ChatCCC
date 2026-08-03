/**
 * progress/view.ts — 平台无关的"过程进度"视图模型
 *
 * 这是飞书过程卡片与终端过程区块共享的唯一数据模型：
 *  - 飞书：buildProgressCard(view) 把 ProgressView 渲染为卡片 JSON
 *  - 终端：TerminalProgressRenderer 把 ProgressView 渲染为 ANSI 区块
 *  - 事件流：reduceProgress(prev, event) 把 ChatEvent 增量合并进 ProgressView
 *
 * 语义与飞书卡片对齐：
 *  - headerTitle 是"生成中"阶段展示的标题（如"正在启动 Agent · 0秒"）
 *  - status 决定终态外观（完成 / 已停止 / 异常结束）
 *  - text 是正文累积（对应卡片 main_content / 终端区块正文）
 *  - tools 是本轮工具调用列表（飞书卡片暂不展示，终端折叠为单行）
 */

export type ProgressStatus = "generating" | "done" | "stopped" | "error";

export type ProgressToolStatus = "running" | "ok" | "error";

export interface ProgressToolCall {
  /** 工具调用 ID（ChatEvent.tool_use.id，可能缺失） */
  id: string;
  /** 工具名，如 edit_file */
  name: string;
  status: ProgressToolStatus;
  /** 工具输入摘要（终端折叠行展示，截断保存） */
  detail?: string;
  /** 工具结果摘要（成功/失败，截断保存） */
  summary?: string;
}

export interface ProgressView {
  /** 当前阶段状态，决定终态外观 */
  status: ProgressStatus;
  /** 生成中阶段的头部标题（对应飞书卡片 header title） */
  headerTitle: string;
  /** 卡片头部颜色模板（飞书用），终端忽略 */
  headerTemplate: string;
  /** 正文累积内容 */
  text: string;
  /** 本轮工具调用列表 */
  tools: ProgressToolCall[];
  /** 是否展示停止按钮 / 停止提示 */
  showStop: boolean;
  /** 最近一次更新时间戳 */
  updatedAt: number;
}

export interface ProgressViewInit {
  status?: ProgressStatus;
  headerTitle?: string;
  headerTemplate?: string;
  text?: string;
  tools?: ProgressToolCall[];
  showStop?: boolean;
}

/** 创建 ProgressView，未提供的字段使用与飞书 buildProgressCard 一致的默认值 */
export function progressView(init: ProgressViewInit = {}): ProgressView {
  return {
    status: init.status ?? "generating",
    headerTitle: init.headerTitle ?? "生成中...",
    headerTemplate: init.headerTemplate ?? "blue",
    text: init.text ?? "",
    tools: init.tools ?? [],
    showStop: init.showStop ?? true,
    updatedAt: Date.now(),
  };
}

/** 只读浅拷贝并覆盖部分字段，返回新视图（reducer 的不可变更新用） */
export function withProgressView(
  prev: ProgressView,
  patch: Partial<ProgressView>,
): ProgressView {
  return { ...prev, ...patch, updatedAt: Date.now() };
}
