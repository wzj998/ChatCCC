# 内置 CLI Agent 架构设计

> 2026-05-18

## 动机

ChatCCC 目前依赖外部 CLI 工具（Claude Code、Cursor、Codex CLI）作为 Agent 后端。需要增加一个不依赖外部 CLI、直接调 LLM API 的自建 Agent，目标是：

1. **零外部依赖** — 不需要用户额外安装任何工具，ChatCCC 自带 Agent 能力
2. **多 Provider 支持** — DeepSeek、Anthropic、OpenRouter 等，用户自由选择
3. **缓存优化** — 面向 DeepSeek 的自动前缀缓存机制，目标 98%+ 命中率
4. **IM + CLI 双模式** — 既能在飞书/微信中用，也能在终端直接对话

---

## 目录结构

```
src/builtin/
├── index.ts           # 对外入口：createBuiltinAdapter()
├── adapter.ts         # ToolAdapter 桥接层（对接现有 IM 系统）
├── agent-loop.ts      # 核心对话循环：LLM → 工具执行 → 结果回传
├── toolkit.ts         # 工具注册表：定义 / 注册 / 序列化为 LLM Schema
├── tools/
│   ├── bash.ts        # Shell 执行
│   ├── read.ts        # 读取文件
│   ├── write.ts       # 写入文件
│   ├── edit.ts        # 搜索替换编辑
│   ├── glob.ts        # 文件名搜索
│   └── grep.ts        # 内容搜索
├── history.ts         # 会话消息历史（纯追加式，缓存敏感）
├── prompt.ts          # 系统提示词 + 工具定义构建（确定性输出）
├── provider.ts        # LLM Provider 注册表 + 懒加载
├── cli.ts             # 独立终端 REPL 入口
└── types.ts           # 内部类型定义
```

---

## 架构层次

```
┌──────────────────────────────────────────┐
│  cli.ts          │   adapter.ts          │  ← 两种入口
│  (终端 REPL)      │   (ToolAdapter 桥接)   │
├──────────────────────────────────────────┤
│           agent-loop.ts                  │  ← 核心循环
│  LLM 调用 → 解析 → 工具执行 → 回传         │
├──────────────┬───────────────────────────┤
│  provider.ts │  toolkit.ts  history.ts   │  ← 基础设施
│  (模型抽象)   │  (工具系统)   (消息存储)    │
├──────────────┴───────────────────────────┤
│  prompt.ts  (缓存优化的提示词构建)          │  ← 缓存层
└──────────────────────────────────────────┘
```

---

## 核心模块设计

### 1. Provider 层（`provider.ts`）

**设计目标**：支持多 LLM Provider，按需懒加载，客户端单例复用。

```typescript
// Provider 描述
interface ProviderSpec {
  id: string;                       // "deepseek" | "anthropic" | "openrouter"
  create: () => Promise<LanguageModel>;  // 懒加载工厂
}

// 注册表
const registry: Record<string, ProviderSpec> = {
  deepseek: {
    id: "deepseek",
    create: () => import("@ai-sdk/openai-compatible")
      .then(m => m.createOpenAICompatible({
        name: "deepseek",
        baseURL: "https://api.deepseek.com/v1",
      })),
  },
  // ... 更多 provider
};

// 获取模型实例（带单例缓存）
async function resolve(config: ModelConfig): Promise<LanguageModel> { ... }
```

**关键决策**：
- 使用 Vercel AI SDK（`ai` 包）作为统一抽象层，Provider 只需实现一次
- 采用 OpenAI 兼容模式接入 DeepSeek（`@ai-sdk/openai-compatible`），和官方 `@ai-sdk/deepseek` 包相比更灵活
- Provider 工厂使用 `import()` 动态加载，启动时零开销

### 2. 工具系统（`toolkit.ts`）

**设计目标**：工具定义、参数校验、确定性 LLM Schema 输出。

```typescript
// 工具上下文（执行时注入）
interface ToolContext {
  cwd: string;           // 当前工作目录
  sessionId: string;     // 会话 ID
  signal?: AbortSignal;  // 取消信号
}

// 工具定义
interface ToolSpec<TParams = unknown> {
  name: string;                    // 工具名，如 "bash", "read"
  description: string;             // 给 LLM 看的描述
  parameters: z.ZodType<TParams>;  // Zod 参数 schema
  execute: (params: TParams, ctx: ToolContext) => Promise<string>;
}

// 工具注册表
class Toolkit {
  private tools = new Map<string, ToolSpec>();

  register(tool: ToolSpec): void;
  get(name: string): ToolSpec | undefined;

  // 生成 LLM 可用的工具 Schema（确定性排序，缓存友好）
  buildLLMSchemas(): Record<string, unknown> {
    // 按工具名排序，保证每次输出相同
    const sorted = [...this.tools.entries()]
      .sort(([a], [b]) => a.localeCompare(b));
    // 使用 sortKeys JSON 序列化
    // ...
  }
}
```

**关键决策**：
- 使用 Zod 做参数校验，轻量且 Vercel AI SDK 4.x 原生支持
- 工具 Schema 输出使用 `sortKeys` 序列化，避免 JSON key 顺序不稳定导致缓存失效
- 工具按照名称字母序排列，保证确定性

### 3. 会话历史（`history.ts`）

**设计目标**：纯追加式消息存储，不修改已写入的消息，最大化缓存命中率。

```typescript
// 消息类型
type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

// 会话历史
class SessionHistory {
  private systemMsg: ChatMessage;     // 创建时冻结
  private turns: ChatMessage[] = [];  // 纯 push，不修改

  constructor(systemPrompt: string) {
    this.systemMsg = { role: "system", content: systemPrompt };
  }

  // 追加消息（唯一允许的写操作）
  addUserMessage(text: string): void;
  addAssistantMessage(content: string, toolCalls?: ToolCall[]): void;
  addToolResult(id: string, name: string, content: string): void;

  // 构建完整消息列表（system + 所有 turns）
  toMessages(): ChatMessage[] {
    return [this.systemMsg, ...this.turns];
  }

  // 获取当前轮数
  get turnCount(): number { ... }
}
```

**关键决策**：
- 永不执行"压缩"（compaction）— 压缩会修改消息数组前缀，导致全部缓存失效
- System 消息在 SessionHistory 创建时冻结，后续不变
- 消息结构扁平化（role + content），不做复杂的 Part 类型体系

### 4. 核心循环（`agent-loop.ts`）

**设计目标**：LLM 调用 → 工具解析 → 本地执行 → 结果回传，完全自主可控。

```
                    ┌─────────────┐
    用户消息 ──────→ │ 构建消息列表  │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
           ┌───────│  LLM 调用    │
           │       └──────┬──────┘
           │              │
           │     ┌────────▼────────┐
           │     │ 解析响应流       │
           │     │ text? → 输出文本  │
           │     │ tool? → 收集调用  │
           │     └────────┬────────┘
           │              │
           │     ┌────────▼────────┐
           │     │ 有工具调用？      │
           │     └───┬────────┬────┘
           │      是 │        │ 否
           │         │        └──→ 返回最终文本
           │  ┌──────▼──────┐
           │  │ 本地执行工具   │
           │  └──────┬──────┘
           │         │
           │  ┌──────▼──────┐
           │  │ 追加结果到    │
           │  │ 消息历史      │
           │  └──────┬──────┘
           │         │
           │  ┌──────▼──────┐
           │  │ 未超步数？    │
           │  └───┬─────────┘
           │   是 │    │ 否 → 返回最终文本
           └──────┘
```

**关键决策**：
- 使用 `streamText({ maxSteps: 1 })` 而非 `maxSteps: N`，每次 LLM 调用只返回一轮工具调用
- 手动执行工具，而非交给 SDK 自动执行 — 可以在每步之间做截断、日志、进度展示
- 工具执行结果作为新消息追加到历史末尾，不修改已有消息

### 5. 提示词构建（`prompt.ts`）

**设计目标**：确定性输出，每次构建的字节完全一致，保证 DeepSeek 前缀缓存命中。

```typescript
// 系统提示词 — 编译期常量，永不拼接动态值
const SYSTEM_PROMPT_BASE = [
  "你是一个 AI 编程助手，运行在终端环境中。",
  "",
  "## 工作方式",
  "- 使用工具执行操作：bash 运行命令、read 读文件、write 写文件、edit 编辑",
  "- 每次工具调用后会收到结果，然后决定下一步",
  "- 修改文件后不需要运行测试来验证，除非用户要求",
  "",
  "## 规则",
  "- 优先使用工具而非纯文本回答问题",
  "- 写入文件前确认路径正确",
  "- bash 命令默认超时 60 秒",
].join("\n");

function buildSystemPrompt(cwd: string, toolSchemas: string): string {
  // cwd 在会话创建时确定，后续不变
  // toolSchemas 由 Toolkit.buildLLMSchemas() 产生，确定性的
  return [
    SYSTEM_PROMPT_BASE,
    "",
    `[工作目录] ${cwd}`,
    "",
    "[可用工具]",
    toolSchemas,
  ].join("\n");
}
```

**缓存友好关键规则**：
1. 系统提示词内容完全写死在常量中
2. cwd 在创建会话时确定，永不改变
3. 工具 Schema 使用 `sortKeys` 确定性序列化，按名称排序
4. 消息列表纯追加，不插入/删除/修改已有消息
5. 工具结果始终以固定格式序列化
6. 不在消息中拼接时间戳或随机 UUID

### 6. ToolAdapter 桥接层（`adapter.ts`）

**设计目标**：实现现有 `ToolAdapter` 接口，无缝接入 ChatCCC 的 IM 桥接系统。

```typescript
class BuiltinAdapter implements ToolAdapter {
  readonly displayName = "ChatCCC";
  readonly sessionDescPrefix = "ChatCCC Session:";

  private sessions = new Map<string, {
    history: SessionHistory;
    cwd: string;
    createdAt: number;
  }>();

  async createSession(cwd: string): Promise<CreateSessionResult> { ... }

  async *prompt(
    sessionId: string,
    userText: string,
    cwd: string,
    signal?: AbortSignal,
  ): AsyncIterable<UnifiedStreamMessage> { ... }

  async getSessionInfo(sessionId: string): Promise<SessionInfo> { ... }
  async closeSession(sessionId: string): Promise<void> { ... }
}
```

**关键决策**：
- 适配器仅做协议转换（Agent 循环 ↔ UnifiedStreamMessage），不包含业务逻辑
- 业务逻辑全部在 `agent-loop.ts`、`toolkit.ts`、`history.ts` 中
- `displayName` 和 `sessionDescPrefix` 统一用 "ChatCCC"，表示这是 ChatCCC 自带的 Agent

### 7. CLI 入口（`cli.ts`）

**设计目标**：独立终端 REPL，不依赖 IM 系统即可使用。

```
$ npx tsx src/builtin/cli.ts
ChatCCC > 帮我看看 package.json 里有什么依赖

[Agent 输出...]

ChatCCC > _
```

- 使用 Node.js 原生 `readline` 实现 REPL
- 支持 `Ctrl+C` 中断当前操作
- 可扩展为多面板 TUI（思考过程 / 文本输出 / 工具调用分栏展示）

---

## 缓存命中率优化策略

### 核心原理

DeepSeek 采用**自动前缀缓存**：从消息列表第一条开始比对，连续相同的字节全部命中缓存。只有当某个位置的字节发生变化时，该位置及之后的内容需要重新计算。

### 优化手段

| # | 手段 | 效果 |
|---|---|---|
| 1 | 系统提示词完全冻结，无动态拼接 | 首条消息永久命中 |
| 2 | 工具 Schema 确定性序列化（sortKeys + 字母序） | 工具定义块永久命中 |
| 3 | 消息历史纯追加（push only） | 每次请求仅最新一条用户消息不命中 |
| 4 | 不进行会话内压缩（compaction） | 避免修改中间消息导致缓存全部失效 |
| 5 | 工具结果固定格式 + 固定截断长度 | 相同结果产生相同字节 |
| 6 | Provider 客户端单例复用 | 避免每轮重建 HTTP 连接 |

### 预期效果

假设一轮对话包含：1 条 system 消息 + 10 条历史消息 + 1 条新用户消息 = 12 条消息。

- 命中缓存：11 条（system + 10 条历史）
- 未命中：1 条（新用户消息）
- 缓存命中率：~92% （消息数维度）

实际 token 维度下，system 消息 + 工具定义占据了绝大部分 token，命中率可达 98%+。

---

## 与现有系统的集成

`BuiltinAdapter` 实现 `ToolAdapter` 接口后，现有 IM 桥接系统完全复用：

- **会话创建**：`/new chatccc`（默认）或 `/new builtin`
- **消息发送**：`session.ts → runAgentSession() → adapter.prompt()` 自动工作
- **会话切换**：`/sessions` 列表、`/session N` 切换
- **显示循环**：`ensureDisplayLoop()` 每 3 秒读取 stream-state 推送进度卡
- **停止会话**：`/stop` 通过 abort signal 传播到 Agent 循环

### 需要改动的文件

| 文件 | 改动内容 |
|---|---|
| `src/config.ts` | 新增 `BuiltinConfig` 配置段（enabled, defaultAgent, model, provider, baseUrl, apiKey），`AgentTool` 类型增加 `"builtin"` |
| `src/session.ts` | `getAdapterForTool()` 增加 `"builtin"` 分支 |
| `src/orchestrator.ts` | `/new` 命令中 validTools 数组增加 `"builtin"` |
| `config.sample.json` | 增加 `builtin` 配置示例 |

### 不改动的文件

- `src/adapters/adapter-interface.ts` — `ToolAdapter` 接口无需变更
- `src/session.ts`（除适配器工厂）— `runAgentSession`、display loop 等完全复用
- `src/cards.ts` — `buildHelpCard` 的 `defaultToolLabel` 参数已支持动态名称
- `src/feishu-api.ts` / `src/wechat-platform.ts` — 平台代码完全不变

---

## 实施路径

### Phase 1：纯文本对话 MVP
- 新建 `src/builtin/` 目录
- 实现 provider、history、prompt、adapter、cli
- 通过 ToolAdapter 接口接入 IM 系统
- 验证：CLI 和飞书中都能纯文本对话

### Phase 2：工具系统
- 实现 toolkit、agent-loop
- 实现 4 个基础工具（bash / read / write / edit）
- 接入 DeepSeek provider
- 验证：Agent 能自主使用工具完成任务

### Phase 3：缓存优化
- 确定性序列化验证测试
- 缓存命中率监控（`usage.cached_input_tokens`）
- 目标：10 轮对话命中率 98%+

### Phase 4：完善
- 补充 glob、grep 工具
- 多 Provider（OpenRouter、Anthropic、本地 Ollama）
- 错误处理、超时、中断完善
- 终端 TUI 多面板展示

---

## 技术选型

| 组件 | 选择 | 原因 |
|---|---|---|
| LLM SDK | `ai` (Vercel AI SDK) | 多 Provider 统一抽象，支持 streaming、tool calling |
| DeepSeek 接入 | `@ai-sdk/openai-compatible` | DeepSeek API 兼容 OpenAI 格式 |
| 参数校验 | `zod` | 轻量，Vercel AI SDK 原生支持 |
| 文件操作 | Node.js `fs/promises` | 零额外依赖 |
| Shell 执行 | `child_process.execFile` | 标准 API |
| 终端 REPL | `readline` | Node.js 原生 |