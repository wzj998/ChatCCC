# ChatCCC 自我迭代规划

## 目标

创建一个 Agent，它能：
1. 作为 ChatCCC 的**使用者**，通过飞书与 Claude Code 交互
2. 自主改进 ChatCCC 项目代码（修 bug、加功能、重构）
3. 在使用过程中遇到问题时，分析根因并优化 ChatCCC 自身

## 仓库拆分建议：**同一仓库**

Agent 代码放在 ChatCCC 仓库的 `agent/` 或 `dogfood/` 目录下。

### 核心理由

**1. 简单直接**
Agent 直连 ChatCCC 源码，不需要跨仓库协调、npm 发布、版本升级等中间环节。开发迭代更快。

**2. 代码即文档**
Agent 的 prompt 和工作流与 ChatCCC 放在一起，使用者可以直接参考 Agent 怎么用 ChatCCC，是最直观的示例。

**3. 避免过度工程**
当前阶段 Agent 逻辑还在探索中，先在同一仓库快速验证，等真正成熟了再考虑拆分。

**4. 内部狗粮**
Agent 源码级访问 ChatCCC，能更深度地发现架构问题，同时保持了"Agent 通过飞书交互"的外部使用路径。

## Agent 工作流（六步 PR 法）

```
飞书群消息 → ChatCCC → Claude Code Agent
                ↑              ↓
                │      修改 ChatCCC 代码
                │              ↓
                └── ④ 自动提 PR 并合并（同一仓库，合并到 dev）
```

| 步骤 | 内容 |
|------|------|
| ① 接收任务 | 用户通过飞书指派，或定时触发 |
| ② 分析定位 | 阅读代码，理解上下文，定位问题根因 |
| ③ 编写修改 | 写代码 / 修 bug / 补测试 / 更新文档 |
| ④ 提 PR 并自动合并 | `gh pr create` + `gh pr merge --merge`，同一步完成 |
| ⑤ 同步公文仓库 | 通过 sync.mjs 同步到 ChatCCC 公有仓库，提 PR 合并到 main |
| ⑥ npm 发布 | `npm version patch` + `npm publish`，新版本上线 |

关键点：
- 步骤 ④ 中**提 PR 和合并 PR 为同一步**，减少等待和人工介入，Agent 直接合到 dev
- 步骤 ⑤ 中公有仓库仍走 PR review 流程（dev → main），保持发布审核
- 步骤 ⑥ 发布使 npm 用户也能用上改进

## 初始切入点

Agent 可以从以下几个方向开始：

- **自动修 bug**：监控 issue，尝试修复简单 bug
- **文档同步**：当代码改动时，自动更新相关文档和 skill md
- **体验优化**：作为使用者发现 friction，直接改 ChatCCC 消除 friction
- **测试补全**：对未覆盖的路径自动生成测试

## 技术要点

- Agent 代码放在 `agent/` 目录下，含 prompt、工作流配置、定时任务等
- Agent 通过飞书群与 ChatCCC 交互（和普通用户一样），但源码级读写仓库
- 步骤 ④ 合并到 dev，步骤 ⑤ 公有仓库提 PR 合并到 main
- 初期可手动触发，稳定后接入 cron/CI