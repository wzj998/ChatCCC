export interface SkippedUnsupportedChat {
  chatId: string;
  platformKind: string;
}

export interface FeishuTargetSplit {
  targetChatIds: string[];
  skippedUnsupported: SkippedUnsupportedChat[];
}

export function splitFeishuTargetChats(
  chatIds: readonly string[],
  getPlatformKind: (chatId: string) => string | undefined,
): FeishuTargetSplit {
  const targetChatIds: string[] = [];
  const skippedUnsupported: SkippedUnsupportedChat[] = [];

  for (const chatId of chatIds) {
    const platformKind = getPlatformKind(chatId);
    if (platformKind === "wechat") {
      skippedUnsupported.push({ chatId, platformKind });
      continue;
    }
    targetChatIds.push(chatId);
  }

  return { targetChatIds, skippedUnsupported };
}
