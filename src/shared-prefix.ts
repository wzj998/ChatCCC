export const ABD_PREFIX = "/abd";

export const ABD_APPEND_PROMPT =
  "请从第一性原理出发挖掘我的真实需求。你觉得我的需求合理吗？开始实现之前有什么问题要问我的？";

export const ABD_HELP_LINE =
  `发送 **${ABD_PREFIX}** 前缀消息，将以第一性原理追问真实需求、合理性和实现前问题`;

export interface SharedPrefixResult {
  matched: boolean;
  text: string;
  body: string;
  prefix?: typeof ABD_PREFIX;
}

export function applySharedPrefix(text: string): SharedPrefixResult {
  if (!text.toLowerCase().startsWith(ABD_PREFIX)) {
    return { matched: false, text, body: text };
  }

  const body = text.slice(ABD_PREFIX.length).replace(/^\s+/, "");
  const appendix = ["---", ABD_APPEND_PROMPT].join("\n");
  return {
    matched: true,
    prefix: ABD_PREFIX,
    body,
    text: body ? [body, appendix].join("\n\n") : appendix,
  };
}
