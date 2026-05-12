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
│  │  │ RealFeishuPlatform │  │ SimulatedFeishuPlatform│  │        │
│  │  │ (现有 feishu-api)   │  │ (本次新建)              │  │        │
│  │  └────────────────────┘  └───────────┬────────────┘  │        │
│  └──────────────────────────────────────┼───────────────┘        │
│                                         │                        │
│  ┌──────────────────────────────────────┼───────────────┐        │
│  │  SimulatedFeishuPlatform 内部组件      │               │        │
│  │                                      │               │        │
│  │  ┌────────────────────┐  ┌───────────▼──────────┐   │        │
│  │  │ MessageStore       │  │ ChatStore            │   │        │
│  │  │ (消息收发存储)      │  │ (群聊/用户模拟)       │   │        │
│  │  │ - 生成 message_id  │  │ - 生成 chat_id       │   │        │
│  │  │ - JSONL 持久化     │  │ - chat info 管理     │   │        │
│  │  │ - SSE 实时推送     │  │ - 用户身份模拟        │   │        │
│  │  └────────────────────┘  └──────────────────────┘   │        │
│  │                                                     │        │
│  │  ┌────────────────────┐  ┌──────────────────────┐   │        │
│  │  │ MediaStore         │  │ CardKitStore         │   │        │
│  │  │ (图片/文件存储)     │  │ (卡片状态存储)        │   │        │
│  │  │ - 本地路径直通     │  │ - card_id 映射       │   │        │
│  │  │ - file_key 生成    │  │ - 更新序列号管理      │   │        │
│  │  └────────────────────┘  └──────────────────────┘   │        │
│  └─────────────────────────────────────────────────────┘        │
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐        │
│  │  模拟 Web UI (新增)                                   │        │
│  │  - 消息输入框 + 发送按钮                               │        │
│  │  - 会话列表（模拟多个群聊）                             │        │
│  │  - 实时消息流（SSE）                                  │        │
│  │  - /new、/stop 等命令快捷按钮                         │        │
│  └──────────────────────────────────────────────────────┘        │
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐        │
│  │  session.ts / adapters / agent-rpc (不变)             │        │
│  └──────────────────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────────────────┘
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

### 4.1 `FeishuPlatform` 接口

```typescript
// src/feishu-platform.ts (新建)

interface FeishuPlatform {
  // 认证 (模拟模式下返回固定 token)
  getTenantAccessToken(): Promise<string>;

  // 消息发送
  sendTextReply(token: string, chatId: string, text: string): Promise<boolean>;
  sendCardReply(token: string, chatId: string, title: string, content: string, template: string): Promise<boolean>;
  sendImageReply(token: string, chatId: string, imagePath: string): Promise<boolean>;
  sendFileReply(token: string, chatId: string, filePath: string): Promise<boolean>;

  // 消息管理
  addReaction(token: string, messageId: string, emojiType?: string): Promise<void>;
  recallMessage(token: string, messageId: string): Promise<boolean>;
  updateCardMessage(token: string, messageId: string, content: string): Promise<boolean>;

  // 群聊管理
  createGroupChat(token: string, name: string, userIds: string[]): Promise<string>;
  updateChatInfo(token: string, chatId: string, name: string, description: string): Promise<void>;
  getChatInfo(token: string, chatId: string): Promise<{ name: string; description: string }>;
  setChatAvatar(token: string, chatId: string, tool: string, status: string): Promise<void>;

  // 图片下载
  getOrDownloadImage(token: string, messageId: string, fileKey: string): Promise<string>;

  // 权限验证 (模拟模式下直接返回全部通过)
  verifyAllPermissions(token: string): Promise<PermissionResult[]>;

  // 消息接收 (模拟模式下通过 injectMessage 触发)
  onMessage(handler: MessageHandler): void;
  onCardAction(handler: CardActionHandler): void;

  // 模拟模式专用：注入消息触发处理流程
  injectMessage?(event: SimulatedMessageEvent): Promise<void>;

  // 启动/停止
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

### 4.2 消息注入 API

```
POST /api/sim/inject-message
Content-Type: application/json

{
  "text": "/new claude",       // 消息文本
  "chat_id": "sim_abc123",     // 目标群 ID (可选，留空则发给默认群)
  "open_id": "sim_user_001",   // 发送者 ID (可选，默认当前模拟用户)
  "chat_type": "group",        // "group" 或 "p2p"
  "message_type": "text"       // "text" | "image" | "media" | "post"
}
```

该端点将消息构造为与飞书 WebSocket 推送一致的 `Evt` 结构，直接调用现有 `handleCommand` 流程。

同时支持图片消息注入（`--path` 指本地文件），模拟用户发图场景：

```
POST /api/sim/inject-message
Content-Type: application/json

{
  "text": "",
  "chat_id": "sim_abc123",
  "message_type": "image",
  "image_path": "C:/Users/me/Pictures/screenshot.png"
}
```

### 4.3 消息输出与 SSE 推送

发送的消息写入 `~/.chatccc/sim/messages.jsonl`，同时通过 SSE 实时推送给 Web UI：

```
GET /api/sim/events
→ SSE stream

event: message
data: {"direction":"send","chat_id":"sim_abc123","content":"你好！...","timestamp":1700000000000}

event: message
data: {"direction":"recv","chat_id":"sim_abc123","content":"/new claude","timestamp":1700000001000}

event: card
data: {"chat_id":"sim_abc123","card_id":"sim_card_001","content":"...","header":"生成中..."}
```

### 4.4 各 Store 设计

#### MessageStore

```
存储位置: ~/.chatccc/sim/messages.jsonl
作用: 记录所有收发消息

结构:
{
  "message_id": "sim_msg_<uuid>",   // 模拟 message_id
  "chat_id": "sim_abc123",
  "direction": "send" | "recv",
  "content": "消息文本或 JSON",
  "msg_type": "text" | "interactive" | "image" | "file",
  "timestamp": 1700000000000,
  "sender_open_id": "sim_user_001",
  "extra": {                        // 发送消息的额外元数据
    "image_path": "...",            // 图片本地路径
    "file_path": "...",             // 文件本地路径
    "card_json": "...",             // 卡片 JSON (供 Web UI 渲染)
    "recalled": false               // 是否已撤回
  }
}
```

#### ChatStore

```
存储位置: ~/.chatccc/sim/chats.json
作用: 管理模拟群聊

结构:
{
  "chats": {
    "sim_default": {
      "chat_id": "sim_default",
      "name": "默认模拟会话",
      "description": "",
      "members": ["sim_user_001"],
      "created_at": 1700000000000
    }
  },
  "users": {
    "sim_user_001": {
      "open_id": "sim_user_001",
      "name": "Developer",
      "avatar_url": ""
    }
  }
}
```

模拟模式下 `createGroupChat` 不调飞书 API，而是在 ChatStore 中创建记录并返回生成的 `chat_id`（格式：`sim_<uuid>`）。

#### MediaStore

```
存储位置: ~/.chatccc/sim/media/
作用: 模拟图片/文件上传下载

- "上传"操作：生成 file_key/image_key，记录本地路径映射
- "下载"操作：直接返回本地路径（图片已在本地，无需网络下载）
- 文件映射存储在: ~/.chatccc/sim/media/media-map.json
```

#### CardKitStore

```
存储位置: 内存 (进程级)
作用: 模拟 CardKit 卡片生命周期

- createCardKitCard: 生成模拟 card_id（格式：sim_card_<uuid>），存储卡片内容
- sendCardKitMessage: 记录卡片已发送，通过 SSE 推送给 Web UI
- updateCardKitCard: 根据 card_id + sequence 更新卡片内容，通过 SSE 推送给 Web UI
- 状态变化通过 SSE 推送，Web UI 实时渲染
```

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

#### 第一阶段：最小可用（MVP）

**目标**：能通过 HTTP API 发送文本消息，收到 AI 回复并以文本形式返回。

- 新建 `src/feishu-platform.ts`：定义接口
- 新建 `src/sim-platform.ts`：实现 `SimulatedFeishuPlatform`
  - `getTenantAccessToken` 返回固定 token
  - `sendTextReply` 写本地 JSONL + SSE 推送
  - `sendCardReply` 降级为 `sendTextReply`（第一版不做卡片）
  - `createGroupChat` 返回模拟 chat_id
  - `getChatInfo` 返回内存中的群信息
  - `verifyAllPermissions` 直接返回全部通过
  - `onMessage` 注册回调
  - `injectMessage` HTTP 端点注入消息
- 修改 `src/index.ts`：检测 `--simulate`，走模拟分支
- **不修改 `session.ts`、adapters、agent-rpc**

#### 第二阶段：卡片与富媒体

**目标**：支持卡片消息渲染、图片/文件收发。

- `SimulatedFeishuPlatform` 实现 CardKit 模拟
- SSE 推送卡片更新事件
- Web UI 渲染卡片内容（含进度条、停止按钮等）
- 实现 `sendImageReply`、`sendFileReply`（本地路径映射）
- 实现 `getOrDownloadImage`（本地直通）

#### 第三阶段：完善 Web UI

**目标**：完整的 Web 端飞书模拟体验。

- 消息流 UI（聊天气泡风格）
- 卡片实时渲染（含进度更新、停止按钮）
- 多会话切换
- 快捷命令按钮
- 图片/文件预览

### 5.2 文件变动范围

| 文件 | 变动类型 | 说明 |
|------|---------|------|
| `src/feishu-platform.ts` | **新建** | 平台接口定义 |
| `src/sim-platform.ts` | **新建** | 模拟平台实现 |
| `src/sim-stores.ts` | **新建** | MessageStore / ChatStore / MediaStore / CardKitStore |
| `src/sim-ui.ts` | **新建** | 模拟模式 Web UI (HTML 模板 + SSE 处理) |
| `src/index.ts` | 修改 | 增加 `--simulate` 分支，注入 `SimulatedFeishuPlatform` |
| `src/feishu-api.ts` | **不改** | 现有生产路径保持不变 |
| `src/session.ts` | **不改** | 纯业务逻辑不碰 |
| `src/adapters/*` | **不改** | 适配器不碰 |
| `src/agent-*-rpc.ts` | **不改** | Agent RPC 不碰 |

### 5.3 设计约束

1. **生产路径零影响**：模拟模式通过 `--simulate` 显式启动，不传时行为与现在完全一致
2. **不修改 feishu-api.ts**：模拟平台是独立实现，不往现有飞书 API 代码里加 if/else
3. **不修改 session.ts 和 adapters**：这些是纯业务逻辑，与飞书解耦程度已经足够
4. **session.ts 中调用的 `feishu-api.ts` 函数只有 `sendTextReply` 和 `setChatAvatar`**：通过 `FeishuPlatform` 接口注入替换
5. **单测友好**：`SimulatedFeishuPlatform` 可独立实例化用于集成测试，无需 mock 外部服务

## 6. 与现有 --local Relay 模式的关系

模拟模式是 `--local` relay 模式的**替代品**，而非补充：

| 维度 | `--local` Relay | `--simulate` |
|------|----------------|-------------|
| 消息来源 | 另一 ChatCCC 实例转发 | HTTP API / Web UI 直接注入 |
| 是否需飞书 | 是（上游实例需要） | 否 |
| 能否独立运行 | 否 | 是 |
| CI 可用 | 否 | 是 |

模拟模式实现后，`--local` 模式可以保留但不再推荐用于本地开发。

## 7. 测试策略

| 层级 | 内容 | 工具 |
|------|------|------|
| 单元测试 | 各 Store 的 CRUD 操作 | vitest |
| 接口测试 | `SimulatedFeishuPlatform` 接口契约 | vitest |
| 集成测试 | 启动模拟模式 → 注入消息 → 验证回复 | vitest + HTTP client |
| 端到端 | 完整 `/new` → 对话 → `/stop` 流程 | vitest |