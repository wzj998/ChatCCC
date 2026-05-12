# ChatCCC 自我迭代规划

## 目标

创建一个 Agent，它能：
1. 作为 ChatCCC 的**使用者**，通过飞书与 Claude Code 交互
2. 自主改进 ChatCCC 项目代码（修 bug、加功能、重构）
3. 在使用过程中遇到问题时，分析根因并优化 ChatCCC 自身

## 仓库拆分建议：**分开两个仓库**

| 仓库 | 职责 |
|------|------|
| `ChatCCC`（现有） | 飞书 ↔ Claude Code 桥接平台 |
| `ChatCCC-Dogfood`（新建） | 使用 ChatCCC 的自我迭代 Agent |

### 核心理由

**1. Dogfooding 才是真测试**
Agent 应该通过 npm 安装 `chatccc`，以真实用户的身份使用——而不是源码级调用。这样才能发现 npm 包路径、配置、文档等真实问题。

**2. 避免循环耦合**
Agent 改 ChatCCC → ChatCCC 发布新版本 → Agent 拉新版本 → 继续改。如果放在同一仓库，这个闭环就变成了内部调用，失去了验证"外部使用者能否正常工作"的意义。

**3. 独立迭代节奏**
ChatCCC 的迭代不应该被 Agent 的行为阻塞（比如 Agent 改了 ChatCCC 导致自身运行异常）。分开后各自独立 CI，Agent 明确依赖 ChatCCC 的特定版本。

**4. 可作为参考实现**
分开后 `ChatCCC-Dogfood` 是开源用户的最佳实践示范——别人可以 fork 它来创建自己的自改进项目。

### 放在同一仓库的唯一场景

如果 Agent 逻辑非常简单（比如就是一个 cron + prompt），不需要独立版本管理，可以放在 ChatCCC 的 `examples/` 或 `dogfood/` 目录下作为示例。但真正的自主迭代 Agent 大概率会变复杂，还是分开更健康。

## Agent 工作流设想

```
飞书群消息 → ChatCCC → Claude Code Agent
                ↑              ↓
                │      修改 ChatCCC 代码
                │              ↓
                └── 提 PR → review → merge → npm publish
                                ↓
                       Agent 拉新版本，继续迭代
```

关键循环：
1. Agent 接到任务（用户通过飞书指派或定时触发）
2. Agent 分析 ChatCCC 代码，定位问题
3. Agent 编写修改，通过 ChatCCC 的 git 能力提交
4. 用户 review PR，合并发布
5. Agent 升级自身依赖的 chatccc 版本
6. 如果遇到使用障碍（如接口不好用、文档不清），优先改进 ChatCCC 本身

## 初始切入点

Agent 可以从以下几个方向开始：

- **自动修 bug**：监控 issue，尝试修复简单 bug
- **文档同步**：当代码改动时，自动更新相关文档和 skill md
- **体验优化**：作为使用者发现 friction，直接改 ChatCCC 消除 friction
- **测试补全**：对未覆盖的路径自动生成测试

## 技术要点

- Agent 通过 `chatccc` npm 包的 `bin/chatccc.mjs` 启动
- 使用 ChatCCC 的 git 能力操作仓库
- 配置独立于 ChatCCC 主项目，作为普通用户配置
- 初期可手动触发，稳定后接入 cron/CI