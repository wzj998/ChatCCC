# 模拟飞书环境架构设计

## 1. 背景与动机

ChatCCC 当前强依赖飞书开放平台：消息收发、群聊管理、图片/文件上传下载、卡片消息等全部通过飞书 API。这导致：

- **开发调试困难**：每次改动需要真实飞书应用 + 公网可达的 WebSocket 长连接
- **自动化测试缺失**：无法在 CI 中运行端到端测试，因为依赖外部飞书服务
- **本地快速验证受限**：`--local` 中继模式仍需另一台 ChatCCC 实例中转，不能独立运行
- **新贡献者上手门槛高**：需要创建飞书自建应用、配置权限、发布版本

**目标**：设计一套本地模拟飞书环境，让 ChatCCC 在零飞书依赖下完整运行端到端流程。

## 2. 现状架构

```
┌─────────────────────────────────────────────────────────────────┐
│  Feishu Open Platform (外部)                                     │
│  ┌──────────────┐  ┌──────────────────────┐                     │
│  │ WebSocket    │  │ REST API             │                     │
│  │ (消息推送)    │  │ /im/v1/messages      │                     │
│  │              │  │ /im/v1/chats         │                     │
│  │              │  │ /im/v1/images        │                     │
│  │              │  │ /cardkit/v1/cards    │                     │
│  └──────┬───────┘  └──────────┬───────────┘                     │
└─────────┼─────────────────────┼─────────────────────────────────┘
          │                     │
┌─────────┼─────────────────────┼─────────────────────────────────┐
│  ChatCCC 进程                                                    │
│         │                     │                                  │
│  ┌──────▼───────┐  ┌──────────▼───────────┐                     │
│  │ WSClient     │  │ feishu-api.ts        │                     │
│  │ (SDK 长连接)  │  │ getTenantAccessToken │                     │
│  │              │  │ sendTextReply        │                     │
│  │ EventDispatch│  │ sendCardReply        │                     │
│  │  ↓           │  │ createGroupChat      │                     │
│  │ handleCommand│  │ getChatInfo          │                     │
│  └──────────────┘  │ uploadImage          │                     │
│                    │ ...                  │                     │
│                    └──────────────────────┘                     │
│                                                                  │
│  ┌──────────────────────────────────────────┐                    │
│  │ session.ts / adapters / agent-rpc       │                    │
│  │ (与飞书无关的纯业务逻辑)                    │                    │
│  └──────────────────────────────────────────┘                    │
└─────────────────────────────────────────────────────────────────┘
```

**ChatCCC 对飞书的完整依赖清单**（`src/feishu-api.ts`）：

| 功能 | 飞书 API | 函数 |
|------|----------|------|
| 认证 | `POST /auth/v3/tenant_access_token/internal` | `getTenantAccessToken` |
| 接收消息 | SDK WebSocket (`im.message.receive_v1`) | EventDispatcher 回调 |
| 发送文本 | `POST /im/v1/messages` | `sendTextReply` |
| 发送卡片 | `POST /im/v1/messages` (interactive) | `sendCardReply` |
| 发送图片 | `POST /im/v1/images` → `POST /im/v1/messages` | `sendImageReply` |
| 发送文件 | `POST /im/v1/files` → `POST /im/v1/messages` | `sendFileReply` |
| 表情回应 | `POST /im/v1/messages/{id}/reactions` | `addReaction` |
| 撤回消息 | `DELETE /im/v1/messages/{id}` | `recallMessage` |
| 更新卡片 | `PATCH /im/v1/messages/{id}` | `updateCardMessage` |
| 创建群聊 | `POST /im/v1/chats` | `createGroupChat` |
| 更新群信息 | `PUT /im/v1/chats/{id}` | `updateChatInfo` |
| 查询群信息 | `GET /im/v1/chats/{id}` | `getChatInfo` |
| 设置头像 | `POST /im/v1/images` → `PUT /im/v1/chats/{id}` | `setChatAvatar` |
| 下载图片 | `GET /im/v1/messages/{id}/resources/{key}` | `getOrDownloadImage` |
| 权限验证 | 多端点探针 | `verifyAllPermissions` |
| CardKit | `POST/PATCH /cardkit/v1/cards` | `cardkit.ts` |
| 卡片回调 | SDK WebSocket (`card.action.trigger`) | EventDispatcher 回调 |

## 3. 模拟环境架构

### 3.1 核心设计原则

1. **接口抽象，实现可替换**：定义 `FeishuPlatform` 接口，生产用 `RealFeishuPlatform`，模拟用 `SimulatedFeishuPlatform`
2. **最小侵入**：`session.ts`、adapters、agent-rpc 等纯业务逻辑不动
3. **消息注入**：通过 HTTP API（`POST /api/sim/inject-message`）替代飞书 WebSocket 推送
4. **消息输出**：发送的消息写入本地存储（JSONL），同时通过 Server-Sent Events 实时推送给 Web UI
5. **零外部依赖**：无需真实飞书应用、无需 App ID/Secret、无需公网可达

### 3.2 整体架构图

```
┌─────────────────────────────────────────────────────────────────┐
│  ChatCCC 进程 (模拟模式: --simulate)                              │
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐        │
│  │                FeishuPlatform (接口)                   │        │
│  │  ┌────────────────────┐  ┌────────────────────────┐  │        │
│  │  │ RealFeishuPlatform │  │ SimulatedPlatform      │  │        │
│  │  │ (现有 feishu-api)   │  │ (委托到 SimStore)       │  │        │
│  │  └────────────────────┘  └───────────┬────────────┘  │        │
│  └──────────────────────────────────────┼───────────────┘        │
│                                         │                        │
│  ┌──────────────────────────────────────┼───────────────┐        │
│  │  SimStore (核心状态管理，单例 EventEmitter)           │        │
│  │                                                      │        │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │        │
│  │  │ Accounts │  │ Chats    │  │ Messages         │   │        │
│  │  │ bot      │  │ group    │  │ 内存 + JSONL     │   │        │
│  │  │ users    │  │ p2p      │  │ EventEmitter     │   │        │
│  │  └──────────┘  └──────────┘  └──────────────────┘   │        │
│  └──────────────────────────────────────────────────────┘        │
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐        │
│  │  SimAgent (用户编程接口，新建)                          │        │
│  │  - sendMessage(): 进程内调用 handleCommand             │        │
│  │  - on("message"): 订阅 bot 回复                       │        │
│  │  - waitForReply(): Promise 模式等待回复               │        │
│  │  - on("invited_to_group"): 拉群通知                   │        │
│  │  - getMessages(): 查看消息历史                        │        │
│  └──────────────────────────────────────────────────────┘        │
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐        │
│  │  模拟 Web UI (可选)                                    │        │
│  │  - 消息输入框 + 发送按钮                               │        │
│  │  - 会话列表（模拟多个群聊）                             │        │
│  │  - 实时消息流（SSE）                                  │        │
│  └──────────────────────────────────────────────────────┘        │
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐        │
│  │  session.ts / adapters / agent-rpc (不变)             │        │
│  └──────────────────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────────────────┘
```

**账户模型**：

| 角色 | 对象 | 说明 |
|------|------|------|
| Bot | `{ id: "bot", kind: "bot", name: "ChatCCC" }` | 机器人账号，ChatCCC 自身 |
| User | `{ id: "<openId>", kind: "user", name: "..." }` | 用户账号，可创建多个 |
| SimAgent | `createSimAgent(userId)` 返回 | 用户侧编程 API，进程内调用 |

**数据流**（用户发消息 → bot 回复）：

```
SimAgent.sendMessage(chatId, text)
  → dispatchMessage(text, chatId, openId, chatType)
    → simStore.recordMessage(chatId, openId, "text", text)   // 记录用户消息 + emit "message"
    → handleCommand(text, chatId, openId, ...)                // 现有流程不变
      → SimulatedPlatform.sendTextReply(chatId, replyText)
        → simStore.sendReply(chatId, "text", replyText)      // 记录 bot 回复 + emit "message"
          → SimAgent.on("message") 回调触发
```

### 3.3 启动模式对比

| 模式 | 启动参数 | 飞书依赖 | 消息来源 | 适用场景 |
|------|---------|---------|---------|---------|
| SDK 模式 | (默认) | 需要 App ID/Secret + 公网 WebSocket | 飞书开放平台 | 生产环境 |
| Local Relay | `--local` | 需要另一 ChatCCC 实例 | 中继 WebSocket | 开发调试 |
| **模拟模式** | `--simulate` | **零依赖** | HTTP API / Web UI | 本地开发、CI 测试 |

### 3.4 模拟模式启动流程

```
1. 解析 --simulate 参数
2. 跳过飞书凭证检查（explainMissingFeishuCredentialsAndExit）
3. 跳过权限验证（verifyAllPermissions）
4. 初始化 SimulatedFeishuPlatform（替代 Feishu WebSocket + REST 调用）
5. 启动 HTTP Server（与现有 Web UI 共用端口 18080）
6. 挂载模拟消息注入端点 POST /api/sim/inject-message
7. 挂载 SSE 端点 GET /api/sim/events
8. 输出启动提示：模拟模式已就绪，打开 http://127.0.0.1:18080 使用
```

## 4. 组件详细设计

### 4.1 `FeishuPlatform` 接口（已实现）

```typescript
// src/feishu-platform.ts
// 20 个函数，覆盖 feishu-api.ts 全部导出
// 通过 _impl 委托，setPlatform() 运行时切换

interface FeishuPlatform {
  getTenantAccessToken(): Promise<string>;
  sendTextReply(token, chatId, text): Promise<boolean>;
  sendCardReply(token, chatId, title, content, template): Promise<boolean>;
  sendRawCard(token, chatId, cardJson): Promise<boolean>;  // 新增
  sendImageReply(token, chatId, imagePath): Promise<boolean>;
  sendFileReply(token, chatId, filePath): Promise<boolean>;
  addReaction(token, messageId, emojiType?): Promise<void>;
  recallMessage(token, messageId): Promise<boolean>;
  updateCardMessage(token, messageId, content): Promise<boolean>;
  createGroupChat(token, name, userIds): Promise<string>;
  updateChatInfo(token, chatId, name, description): Promise<void>;
  getChatInfo(token, chatId): Promise<{ name; description }>;
  setChatAvatar(token, chatId, tool, status): Promise<void>;
  getOrDownloadImage(token, messageId, fileKey): Promise<string>;
  verifyAllPermissions(token): Promise<PermissionResult[]>;
  reportPermissionResults(results, config): void;
  extractSessionInfo(description): { sessionId; tool } | null;
  extractSessionId(description): string | null;
  formatDelayNotice(createTimeMs, messageText?, nowMs?): string | null;
  sendRestartCard(token): Promise<void>;
}
```

### 4.2 SimStore — 核心状态管理（已实现：`src/sim-store.ts`）

SimStore 是模拟环境的唯一状态中心，继承 EventEmitter：

```
SimStore {
  accounts: Map<string, SimAccount>   // bot + 所有用户
  chats: Map<string, SimChat>         // group + p2p 会话
  
  // 账户
  registerAccount(account): void
  getAccount(id): SimAccount | undefined
  
  // 会话
  createGroupChat(name, memberIds): SimChat     // bot 自动加入
  createP2pChat(userId): SimChat                // p2p_<user>_bot
  getChat(id): SimChat | undefined
  getChatsForUser(userId): SimChat[]
  addMember(chatId, userId): void
  updateChatInfo(chatId, name, description): void
  
  // 消息
  recordMessage(chatId, senderId, type, content): SimMessage  // 通用
  sendReply(chatId, type, content): SimMessage                // bot 发送
  getMessages(chatId, requesterId): SimMessage[]              // 权限校验
  
  // 事件
  // "message"       → { chatId, message: SimMessage }
  // "chat_created"  → { chat: SimChat }
  // "member_added"  → { chatId, userId }
}
```

**消息分发机制**：SimStore 暴露 `setMessageHandler()` / `dispatchMessage()`，让 SimAgent 进程内触发 bot 处理：

```typescript
// 启动时注册（index.ts）
setMessageHandler((text, chatId, openId, ts, chatType, tid) =>
  handleCommand(text, chatId, openId, ts, chatType, tid));

// SimAgent 调用
dispatchMessage(text, chatId, openId, chatType)
  → simStore.recordMessage(chatId, openId, "text", text)  // 记录用户消息
  → _messageHandler(text, chatId, ...)                     // 触发 bot
    → handleCommand → SimulatedPlatform.sendXxxReply → simStore.sendReply
      → emit "message" → SimAgent.on("message") 回调
```

### 4.3 SimAgent — 用户编程接口（已实现：`src/sim-agent.ts`）

纯代码 API，不依赖 UI，适合自动化测试和 Agent 编程：

```typescript
// src/sim-agent.ts
function createSimAgent(userId: string): SimAgent

interface SimAgent {
  userId: string;
  account: SimAccount;

  // 发送消息（进程内触发 handleCommand）
  sendMessage(chatId: string, text: string): Promise<void>;
  
  // 创建与 bot 的私聊
  createP2pWithBot(): string;
  
  // 查看消息（仅本用户所在群的消息）
  getMessages(chatId: string): SimMessage[];
  listChats(): { id, name, type }[];

  // 事件订阅
  on(event: "message", handler: (chatId, msg) => void): void;
  on(event: "invited_to_group", handler: (chatId, userId) => void): void;
  off(event: string, handler): void;

  // Promise 模式等待 bot 回复
  waitForReply(chatId: string, timeoutMs?: number): Promise<SimMessage | null>;
}
```

使用示例：
```typescript
const alice = createSimAgent("alice");
alice.on("message", (chatId, msg) => console.log(msg.content));
alice.on("invited_to_group", (chatId) => console.log("被拉入群:", chatId));

await alice.sendMessage("sim_default", "/new claude");
const reply = await alice.waitForReply("sim_default", 30000);
```

### 4.4 消息注入 API（已实现）

```
POST /api/sim/inject-message
Content-Type: application/json

{
  "text": "/new claude",       // 消息文本
  "chat_id": "sim_default",    // 目标群 ID (可选)
  "open_id": "sim_user_001",   // 发送者 ID (可选)
  "chat_type": "group"         // "group" 或 "p2p"
}
```

该端点调用 `handleCommand` 处理消息，SimAgent 可通过 `sendMessage()` 以纯代码方式完成相同操作。

### 4.5 消息输出与持久化

所有消息写入 `~/.chatccc/sim/messages.jsonl`。SimStore 同时 emit 事件，SimAgent 通过 `on("message")` 或 `waitForReply()` 实时感知。

### 4.6 文件结构

| 文件 | 说明 |
|------|------|
| `src/feishu-platform.ts` | 平台接口 + 代理包装器 |
| `src/sim-platform.ts` | SimulatedPlatform（委托到 SimStore） |
| `src/sim-store.ts` | SimStore（核心状态 + 事件总线 + JSONL） |
| `src/sim-agent.ts` | SimAgent（用户编程接口） |
| `src/index.ts` | `--simulate` 分支 + 消息分发注册 |

### 4.5 模拟 Web UI

在现有 Dashboard 页面（`http://127.0.0.1:18080`）上增加模拟模式界面：

```
┌─────────────────────────────────────────────────────────┐
│  ChatCCC — 模拟飞书环境                                   │
│  [默认模拟会话] [会话2] [会话3]          [+ 新建会话]      │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │ 消息流 (SSE 实时推送)                             │    │
│  │                                                  │    │
│  │  [发送] 你好，请帮我写一个函数                      │    │
│  │  [接收] 好的，这是你需要的函数...                   │    │
│  │  [卡片] 生成中... (实时更新)                       │    │
│  │  [发送] /new cursor                              │    │
│  │  [卡片] Cursor Session Ready                     │    │
│  │  ...                                             │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │ > /new claude                          [发送]    │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  快捷命令: [/new] [/stop] [/status] [/sessions] [/cd]   │
└─────────────────────────────────────────────────────────┘
```

**Web UI 由两部分组成**：
1. 静态 HTML + CSS + 原生 JS（无框架依赖），由现有 `web-ui.ts` 的 HTTP 路由返回
2. SSE 连接 `/api/sim/events` 实时更新消息流和卡片状态

HTTP API 清单：

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/sim/inject-message` | POST | 注入消息（模拟用户发送） |
| `/api/sim/events` | GET | SSE 事件流（消息 + 卡片更新） |
| `/api/sim/chats` | GET | 获取模拟群聊列表 |
| `/api/sim/chats` | POST | 创建模拟群聊 |
| `/api/sim/chats/:id/messages` | GET | 获取指定群聊历史消息 |
| `/api/sim/status` | GET | 获取模拟环境状态 |

## 5. 实施策略

### 5.1 分阶段实施

#### 第一阶段：MVP（已完成 ✅）

**已实现**：
- `src/feishu-platform.ts`：20 个函数的接口 + 代理包装器
- `src/sim-platform.ts`：SimulatedPlatform，所有 20 个接口可工作
- `src/sim-store.ts`：SimStore 单例（账户 + 会话 + 消息 + EventEmitter）
- `src/sim-agent.ts`：SimAgent 编程 API（sendMessage/on/waitForReply）
- `src/index.ts`：`--simulate` 分支，端口 18079，消息分发注册
- `POST /api/sim/inject-message`：HTTP 消息注入端点
- 消息写入 `~/.chatccc/sim/messages.jsonl`
- 358 个单测全部通过（19 个测试文件）

#### 第二阶段：卡片与富媒体（待实施）

**目标**：支持卡片消息渲染、图片/文件收发。

- 实现 `sendImageReply`、`sendFileReply` 的本地路径映射
- 实现 `getOrDownloadImage` 的本地直通
- Web UI 渲染卡片内容（含进度条、停止按钮等）

#### 第三阶段：完善 Web UI（待实施）

**目标**：完整的 Web 端飞书模拟体验。

- 消息流 UI（聊天气泡风格）
- 卡片实时渲染（含进度更新、停止按钮）
- 多会话切换
- 快捷命令按钮
- 图片/文件预览

### 5.2 文件变动范围（已实施）

| 文件 | 变动类型 | 说明 |
|------|---------|------|
| `src/feishu-platform.ts` | **新建** ✅ | 平台接口定义 + 代理包装器（20 个函数） |
| `src/sim-platform.ts` | **新建** ✅ | 模拟平台实现，委托到 SimStore |
| `src/sim-store.ts` | **新建** ✅ | SimStore：账户/会话/消息管理 + EventEmitter |
| `src/sim-agent.ts` | **新建** ✅ | SimAgent：用户编程接口 |
| `src/index.ts` | **修改** ✅ | `--simulate` 分支 + 消息分发注册 + sendRawCard 替换 |
| `src/config.ts` | **修改** ✅ | USE_SIMULATE 标志 |
| `src/feishu-api.ts` | **修改** ✅ | 新增 sendRawCard |
| `src/session.ts` | **修改** ✅ | import 路径切换到 feishu-platform.ts |
| `src/agent-image-rpc.ts` | **修改** ✅ | import 路径切换到 feishu-platform.ts |
| `src/agent-file-rpc.ts` | **修改** ✅ | import 路径切换到 feishu-platform.ts |
| `src/__tests__/feishu-platform.test.ts` | **新建** ✅ | 平台接口测试 |
| `src/__tests__/sim-platform.test.ts` | **新建** ✅ | 模拟平台测试 |
| `src/__tests__/sim-store.test.ts` | **新建** ✅ | SimStore 单元测试 |
| `src/__tests__/sim-agent.test.ts` | **新建** ✅ | SimAgent 单元测试 |
| `src/adapters/*` | **不改** ✅ | 适配器不碰 |
| `src/agent-*-rpc.ts` | **不改** ✅ | 除 import 路径外逻辑不变 |

### 5.3 设计约束

1. **生产路径零影响**：模拟模式通过 `--simulate` 显式启动，不传时行为与现在完全一致
2. **不修改 feishu-api.ts**：模拟平台是独立实现，不往现有飞书 API 代码里加 if/else
3. **不修改 session.ts 和 adapters**：这些是纯业务逻辑，与飞书解耦程度已经足够
4. **session.ts 中调用的 `feishu-api.ts` 函数只有 `sendTextReply` 和 `setChatAvatar`**：通过 `FeishuPlatform` 接口注入替换
5. **单测友好**：`SimulatedFeishuPlatform` 可独立实例化用于集成测试，无需 mock 外部服务

## 6. 与现有 --local Relay 模式的关系

`--local` 和 `--simulate` 解决的是**不同维度**的问题，是互补关系而非替代：

| 维度 | `--local` Relay | `--simulate` |
|------|----------------|-------------|
| 解决什么问题 | **一对多**：一个飞书 App 供多个开发者共用 | **零依赖**：完全不需要飞书即可运行 |
| 消息来源 | SDK 实例转发的真实飞书事件 | HTTP API / Web UI 注入 |
| 是否需要飞书 | 是（上游 SDK 实例仍连飞书） | 否 |
| 能否独立运行 | 否（需 SDK 实例在前） | 是 |
| CI 可用 | 否 | 是 |
| 消息格式保真 | 是（真实飞书事件） | 需自行保证格式一致 |
| 适用场景 | 团队共用飞书 App、需要真实消息验证 | CI 测试、离线开发、新贡献者上手 |

两者共存：想测真实飞书行为时用 `--local`，不需要飞书时用 `--simulate`。

## 7. 测试策略

| 层级 | 内容 | 工具 |
|------|------|------|
| 单元测试 | 各 Store 的 CRUD 操作 | vitest |
| 接口测试 | `SimulatedFeishuPlatform` 接口契约 | vitest |
| 集成测试 | 启动模拟模式 → 注入消息 → 验证回复 | vitest + HTTP client |
| 端到端 | 完整 `/new` → 对话 → `/stop` 流程 | vitest |