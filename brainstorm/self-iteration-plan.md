# ChatCCC 自迭代 Agent 架构设计

## 目标

创建一个始终运行的 Agent，它能：
1. 作为 ChatCCC 的**使用者**，通过模拟 IM 层与 ChatCCC 交互（和普通用户完全一样，但不走真实飞书/微信网络）
2. 通过 ChatCCC 的 Claude 会话自主改进 ChatCCC 项目代码（修 bug、加功能、重构），Agent 自身不直接修改代码
3. 覆盖飞书和微信两个 IM 平台的使用路径，遇到问题时分析根因

## 整体架构

```
┌──────────────────────────────────────────────┐
│  Self-Iter Agent (独立进程, 端口 18081)        │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │ Claude SDK (决策引擎)                    │  │
│  │ - 读取 memory.md 维护上下文              │  │
│  │ - 规划测试任务、分析结果                  │  │
│  └────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────┐  │
│  │ HTTP Client → localhost:18079           │  │
│  │ - POST /api/sim/inject-message          │  │
│  │   {platform, text, chat_id, user_id}    │  │
│  │ - GET /api/sim/chats/:id/messages       │  │
│  └────────────────────────────────────────┘  │
│  memory.md — 运行时记忆文件                    │
└──────────────┬───────────────────────────────┘
               │ HTTP 本地网络
               ▼
┌──────────────────────────────────────────────┐
│  ChatCCC --simulate (单进程, 端口 18079)      │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │ PlatformAdapter 实例                    │  │
│  │ ┌──────────────────┐ ┌───────────────┐  │  │
│  │ │ 飞书模拟适配器     │ │ 微信模拟适配器  │  │  │
│  │ │ kind: "feishu"    │ │ kind:          │  │  │
│  │ │ 群聊 + 卡片 + 全部 │ │ "simulated-    │  │  │
│  │ │ 能力              │ │ wechat"        │  │  │
│  │ │                   │ │ p2p + 纯文本   │  │  │
│  │ └──────────────────┘ └───────────────┘  │  │
│  └────────────────────────────────────────┘  │
│  SimStore (共享): 消息、会话、账户              │
│  orchestrator / session / adapters (不变)     │
└──────────────────────────────────────────────┘
```

## 核心设计决策

### Agent 不直接改代码

Agent 像人类用户一样：通过 ChatCCC 创建会话 → 发送任务消息（"请修改 xxx 文件"）→ ChatCCC 的 Claude 会话执行实际修改和提交。Agent 本身不直接读写源文件。

### 单进程双平台模拟

ChatCCC `--simulate` 在一个 Node.js 进程内同时运行飞书和微信两个模拟适配器。共用一个 HTTP 端口（18079），通过请求中的 `platform` 字段路由到正确的适配器。

### Agent 独立进程

Agent 是独立的 Node.js 进程（端口 18081），通过本地 HTTP 调用 ChatCCC 模拟端口。完全解耦：Agent 挂了不影响 ChatCCC，ChatCCC 重启不影响 Agent。

### Agent 决策引擎

使用 Claude SDK，带 memory.md 作为持久记忆。每次决策循环：读取记忆 → Claude 规划任务 → 执行 → 写回结果。

### 微信模拟适配器

微信模拟实现 `PlatformAdapter` 接口（而非 `FeishuPlatform` 接口，那只是飞书 API 代理层）。微信模拟适配器复用真实微信适配器的文本降级逻辑（卡片→纯文本、防抖去重），但去掉 iLink SDK 依赖和 claw limit，消息直接写入 SimStore。

### 平台检测统一

用辅助函数 `isWechatKind(kind)` 替换散落的 `p.kind === "wechat"` 字符串比较，同时覆盖 `"wechat"` 和 `"simulated-wechat"`。

## 实现阶段

### Phase 1: 微信模拟层

- 新建 `src/sim-wechat-platform.ts`：微信模拟 `PlatformAdapter`
- 扩展 `src/sim-store.ts`：添加微信默认账户和 p2p 会话
- `createSimAgent("wx_user_001")` 即可创建微信模拟用户，无需新建文件

### Phase 2: 双平台模拟模式

- 改造 `src/index.ts` 的 `--simulate` 分支，同时初始化两个平台适配器
- `POST /api/sim/inject-message` 增加 `platform` 字段做路由
- 修复 `session.ts` / `orchestrator.ts` 中的 wechat kind 检测
- 新增 `GET /api/sim/chats/:id/messages` 消息查询 API

### Phase 3: 自迭代 Agent

#### Agent 持续运行机制 — 方案 B：每轮新会话 + memory.md

Claude SDK 的 `prompt()` 是请求-响应模型，用完即止。要让 Agent 持续运行，
在外部包一层 `while(true)` 循环，每轮创建独立会话。记忆由 `memory.md` 持久化。

**流程：**

```
while true:
  // 1. 读记忆
  memory = readMemory()

  // 2. 创建新 Claude SDK 会话（独立上下文，成本可控）
  session = adapter.createSession()
  result = adapter.prompt(fullPrompt, {
    systemPrompt: plannerPrompt + memory
  })
  adapter.closeSession(session)

  // 3. 解析 Claude 的决策输出
  plan = parseResult(result)  // { action, platform, messages[], nextCheck? }

  // 4. 执行
  for msg of plan.messages:
    client.sendMessage(plan.platform, plan.chatId, userId, msg)
    reply = client.waitForReply(plan.chatId)
    记录到 memory

  // 5. 写回记忆
  appendMemory(plan.summary, plan.nextCheck)

  // 6. 等待下次
  if plan.nextCheck:
    sleep until plan.nextCheck
  else:
    sleep defaultInterval  // 如 5 分钟
```

**为什么不用单会话反复 prompt：**
上下文窗口会无限膨胀，token 成本越来越高，且长上下文容易让模型"飘"。

**间隔策略：**
- Agent 自己决定何时检查：Claude 在决策输出中指定 `nextCheck`（如 `"1h"` 或 `"明天 9:00"`）
- 若未指定，默认 5 分钟一轮
- 如果上一轮没发现任何可做的事，Agent 自己写 memory.md："暂无任务，X 小时后再检查"

#### Agent System Prompt 设计

Agent 的 system prompt（`self-iter-agent/prompts/planner.md`）引导它：
1. 读取记忆，了解进度和上下文
2. 决定本次要测试/改进什么
3. 输出结构化的执行计划（平台、消息序列）
4. 评估上一轮结果，判断是否解决问题
5. 指定下次检查时间

#### 记忆文件格式

```markdown
# Self-Iter Agent Memory

## 当前状态
- 最后运行: 2026-05-16 10:30
- 下次检查: 2026-05-16 11:30
- 活跃会话: (无)

## 已知问题
- (待发现)

## 任务模板（Agent 定期从中选取）
1. 飞书: /new claude → 简单对话 → /stop，验证完整流程
2. 微信: /new claude → 简单对话 → /stop，验证完整流程
3. 双平台: 同时在飞书和微信各创建一个会话，验证不互相干扰

## 任务历史
| 时间 | 平台 | 任务 | 结果 |
|------|------|------|------|
```

#### Agent 进程结构

```
self-iter-agent/
├── index.ts              # 入口，while(true) 主循环
├── agent-loop.ts         # 决策循环：读记忆 → Claude 规划 → 执行 → 写记忆
├── chatccc-client.ts     # ChatCCC HTTP 客户端（sendMessage, waitForReply）
├── memory.ts             # 记忆读写（readMemory, appendMemory）
├── prompts/
│   └── planner.md        # Agent 的 system prompt
└── memory.md             # Agent 运行时记忆（任务历史、已知问题）
```

## 文件变更清单

| 文件 | 变更 | 说明 |
|------|------|------|
| `src/sim-wechat-platform.ts` | **新建** | 微信模拟 PlatformAdapter |
| `src/sim-store.ts` | **修改** | 添加微信默认账户和 p2p 会话 |
| `src/sim-api.ts` | **新建** | 消息查询 API |
| `src/index.ts` | **修改** | --simulate 改造为双平台 |
| `src/session.ts` | **修改** | 修复 display loop / IM skill 平台检测 |
| `src/orchestrator.ts` | **修改** | 修复 wechat kind 检测 |
| `self-iter-agent/index.ts` | **新建** | Agent 入口 |
| `self-iter-agent/agent-loop.ts` | **新建** | 决策循环 |
| `self-iter-agent/chatccc-client.ts` | **新建** | HTTP 客户端 |
| `self-iter-agent/memory.ts` | **新建** | 记忆读写 |
| `self-iter-agent/prompts/planner.md` | **新建** | Agent system prompt |
| `self-iter-agent/memory.md` | **新建** | 运行时记忆 |

**不改的文件**：`sim-agent.ts`、`feishu-platform.ts`、`sim-platform.ts`、`platform-adapter.ts`、`adapters/*`