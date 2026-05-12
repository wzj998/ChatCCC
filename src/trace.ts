/**
 * 轻量级消息全链路 trace 工具。
 *
 * 每条消息生成唯一 traceId，在关键决策点、API 调用、消息发送时输出结构化日志。
 * grep traceId 即可看到该消息的完整 RECV → BRANCH → SEND → DONE 链路。
 *
 * 设计原则：trace 自身绝不能抛异常导致主流程中断——所有函数内都有 try/catch 兜底。
 */

let _traceSeq = 0;

/** 基于时间戳 + 递增序号生成短 trace ID（约 10 字符） */
export function makeTraceId(): string {
  try {
    _traceSeq++;
    const ts = Date.now().toString(36).slice(-6);
    const seq = _traceSeq.toString(36).padStart(3, "0");
    return `${ts}${seq}`;
  } catch {
    // 极端情况（计数器溢出等）降级为纯时间戳
    return Date.now().toString(36);
  }
}

/**
 * 输出一条 trace 日志。
 * detail 中的值做浅层截断（字符串 > 200 字符会截断），避免日志膨胀。
 */
export function logTrace(traceId: string, step: string, detail?: Record<string, unknown>): void {
  try {
    const safe: Record<string, unknown> = {};
    if (detail) {
      for (const [k, v] of Object.entries(detail)) {
        if (typeof v === "string" && v.length > 200) {
          safe[k] = v.slice(0, 200) + "...(truncated)";
        } else {
          safe[k] = v;
        }
      }
    }
    const extra = Object.keys(safe).length > 0 ? " " + JSON.stringify(safe) : "";
    console.log(`[TRACE ${traceId}] ${step}${extra}`);
  } catch {
    // trace 自身绝不能抛异常
  }
}

/** 重置序号（仅单测使用，确保 trace ID 可预测） */
export function _resetTraceSeqForTest(): void {
  _traceSeq = 0;
}