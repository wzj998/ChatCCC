/**
 * platform-adapter.ts — IM 平台适配器接口
 *
 * 独立于 orchestrator.ts，避免 orchestrator ↔ session 循环依赖。
 * 每个方法内部自行管理认证，消费者不感知 token 等认证细节。
 */

export interface PlatformAdapter {
  /** 平台标识，用于区分不同平台的行为（如 wechat、feishu 等） */
  kind?: string;

  /** 发送纯文本回复 */
  sendText(chatId: string, text: string): Promise<boolean>;

  /** 发送卡片回复（标题 + 内容 + 颜色模板） */
  sendCard(
    chatId: string,
    title: string,
    content: string,
    template: string,
  ): Promise<boolean>;

  /** 发送原始卡片 JSON */
  sendRawCard(chatId: string, cardJson: string): Promise<boolean>;

  /** 创建群聊，返回新群 ID */
  createGroup(name: string, userIds: string[]): Promise<string>;

  /** 更新群名称和描述 */
  updateChatInfo(
    chatId: string,
    name: string,
    description: string,
  ): Promise<void>;

  /** 获取群信息 */
  getChatInfo(chatId: string): Promise<{ name: string; description: string }>;

  /** 解散群聊 */
  disbandChat(chatId: string): Promise<void>;

  /** 设置群头像 */
  setChatAvatar(chatId: string, tool: string, status: string): Promise<void>;

  /** 从群描述中提取 session 信息 */
  extractSessionInfo(
    description: string,
  ): { sessionId: string; tool: string } | null;

  // ---- 进度展示（display loop 使用） ----
  // 不同平台能力不同：飞书用 CardKit 实时卡片，微信降级为纯文本。

  /** 创建进度展示实体，返回唯一标识；不支持进度展示的平台返回 null */
  cardCreate(cardJson: string): Promise<string | null>;

  /** 将进度展示发送到指定会话，返回 message_id */
  cardSend(chatId: string, cardId: string): Promise<string>;

  /** 更新已发送的进度展示，sequence 保证有序 */
  cardUpdate(cardId: string, cardJson: string, sequence: number): Promise<void>;
}