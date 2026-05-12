# ChatCCC 自我迭代规划

## 目标

创建一个 Agent，它能：
1. 作为 ChatCCC 的**使用者**，通过飞书与 Claude Code 交互
2. 自主改进 ChatCCC 项目代码（修 bug、加功能、重构）
3. 在使用过程中遇到问题时，分析根因并优化 ChatCCC 自身

## 仓库拆分建议：**同一仓库**

Agent 代码放在 ChatCCC 仓库的 `self-iter-agent/` 目录下。

### 核心理由

**1. 简单直接**
Agent 直连 ChatCCC 源码，不需要跨仓库协调、npm 发布、版本升级等中间环节。开发迭代更快。

**2. 代码即文档**
Agent 的 prompt 和工作流与 ChatCCC 放在一起，使用者可以直接参考 Agent 怎么用 ChatCCC，是最直观的示例。

**3. 避免过度工程**
当前阶段 Agent 逻辑还在探索中，先在同一仓库快速验证，等真正成熟了再考虑拆分。

**4. 内部狗粮**
Agent 源码级访问 ChatCCC，能更深度地发现架构问题，同时保持了"Agent 通过飞书交互"的外部使用路径。

## 技术要点

- Agent 代码放在 `self-iter-agent/` 目录下，含 prompt、工作流配置、定时任务等
- Agent 通过飞书群与 ChatCCC 交互（和普通用户一样），但源码级读写仓库
- 发布流程遵循六步发布法（详见 CLAUDE.local.md 双仓库同步发布流程）
- 初期可手动触发，稳定后接入 cron/CI