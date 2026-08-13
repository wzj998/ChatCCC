/**
 * Detects provider output that leaked DeepSeek's internal DSML tool-call syntax
 * into normal assistant text. A trailing closing tag is intentionally required:
 * mentioning DSML in prose or a code sample must not trigger recovery.
 */
const MALFORMED_DSML_TRAILER = /<\/[|｜]{2}DSML[|｜]{2}(?:parameter|invoke)>\s*$/iu;
const RENDERED_TOOL_CALL = /\[调用\s+[A-Za-z_][\w.-]*\]/u;
const DSML_INVOKE_TAG = /<[|｜]{2}DSML[|｜]{2}invoke\b/iu;

export function hasMalformedToolProtocolText(text: string): boolean {
  return MALFORMED_DSML_TRAILER.test(text)
    && (RENDERED_TOOL_CALL.test(text) || DSML_INVOKE_TAG.test(text));
}

export const TOOL_PROTOCOL_RECOVERY_PROMPT = [
  "[系统恢复提示] 上一次响应泄漏了内部工具调用协议，因此已被丢弃。",
  "请重新完成当前用户请求。需要调用工具时，只能使用 API 提供的结构化工具调用；不要把 DSML 或工具参数作为普通文本输出。",
  "不要提及本恢复提示，也不要假装工具已经执行。",
].join("\n");
