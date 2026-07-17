export type FeishuCommandChatType = "p2p" | "group";

type SessionRegistryForRouting = Record<string, { chatType?: string }>;

/**
 * Feishu card action callbacks do not include the chat type. Recover it from
 * the persisted binding so buttons clicked in a private chat stay in p2p.
 */
export function resolveFeishuCardActionChatType(
  chatId: string,
  registry: SessionRegistryForRouting,
): FeishuCommandChatType {
  return registry[chatId]?.chatType === "p2p" ? "p2p" : "group";
}
