# 微信 (iLink) vs 飞书 平台差异

ChatCCC 同时支持飞书和微信两个 IM 平台。飞书是主力平台，微信通过 iLink 接入。两者的能力模型不同，本文档记录核心差异。

## 群聊模型 — 最大差异

| | 飞书 | 微信 (iLink) |
|---|---|---|
| `/new` 行为 | 创建新群聊，每个 AI 会话 = 一个独立群 | 在当前对话内重置会话，不创建新群 |
| 多会话 | 一个用户可加入多个会话群，同时并行 | 一个私聊 = 一个会话，`/new` 只是重建 |
| 群管理 | 创建群、改名、改描述、设头像 | 不支持群管理 |

飞书的 `/new` 会调用 `createGroupChat` 新建群并拉用户入群，群描述中写入 session ID 前缀（如 `CLAUDE:`），后续消息通过群描述自动恢复会话上下文。

微信 `/new` 只重置当前对话的 AI 会话状态，无法创建新群。

## 消息能力

| 能力 | 飞书 | 微信 (iLink) 首版 |
|---|---|---|
| 文本消息 | 支持 | 支持 |
| 卡片消息 (CardKit) | 完整支持，含进度条、按钮 | 不支持，降级为纯文本 |
| 卡片实时更新 | `updateCardMessage` 实时刷新 | 不支持 |
| 图片收发 | 支持上传/下载 | 后续可加 |
| 文件收发 | 支持上传/下载 | 后续可加 |
| 表情回应 | `addReaction` 点赞 | 不支持 |
| 撤回消息 | `recallMessage` | 不支持 |

## 连接与认证

| | 飞书 | 微信 (iLink) |
|---|---|---|
| 连接协议 | WebSocket 长连接 | 长轮询 (long polling) |
| 认证方式 | App ID + App Secret | QR 码扫码登录 |
| 启动行为 | 配置即连 | 每次启动需扫码 |
| 会话持久化 | 无需额外状态 | 需持久化 token、baseUrl、sync cursor |
| 会话过期 | token 过期自动换新 | session 过期需重新扫码 |

## 会话标识

- **飞书**: `oc_xxx` (群 chat_id)，session 通过群描述中的前缀识别
- **微信 (iLink)**: `wx_user_xxx` (用户 ID)，单一私聊窗口

多平台共存时，共享状态使用平台限定的 key：

```
feishu:oc_xxx
ilink:wx_user_xxx
```

## 进度展示降级

- **飞书**: 实时更新一张卡片，展示 thinking → streaming → done 全过程
- **微信**: 降级为少量节流文本更新或只回复最终结果

编排器应通过 `reply.status` / `reply.updateStatus` 是否可用来判断平台能力，不可用时自动降级。

## 运行时架构

两者作为同一进程内的并行平台适配器运行：

```
one ChatCCC Node.js process
├── FeishuPlatform (WebSocket + REST API)
├── IlinkPlatform (long polling + QR login)
└── Shared Orchestrator (平台无关的消息处理)
```

各适配器独立管理连接和恢复，飞书故障不影响微信，反之亦然。

## 命令语义差异

| 命令 | 飞书 | 微信 |
|------|------|------|
| `/new` | 创建新群聊 | 重置当前会话 |
| `/sessions` | 卡片列表 | 文本列表 |
| `/restart` | 重启会话 | 同 |
| `/state` | 卡片展示 | 文本展示 |
| `/cd` | 卡片展示 | 文本展示 |
| `/stop` | 更新卡片为停止状态 | 文本回复已停止 |

## 实现状态

- **飞书**: 生产就绪，完整实现
- **微信 (iLink)**: demo 阶段 (`demo/ilink_echo_probe.ts`)，实现计划参见 `feishu-ilink-multi-platform-architecture.md`