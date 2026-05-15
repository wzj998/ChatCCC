# ChatCCC

**用飞书或微信聊天控制 Claude Code / Cursor / Codex。**

ChatCCC 把本地 AI 编程工具接入即时通讯软件。你可以在手机上发消息，让 Claude Code、Cursor Agent 或 Codex 继续写代码、查问题、跑命令；不用一直守在电脑前。

飞书是推荐入口：群聊就是会话，卡片能流式更新，体验完整。微信 iLink 更适合快速试用或临时使用：扫码即可接入，但只能走私聊文本模式。

<p align="center">
  <img src="images/img_readme_messages.jpg" alt="飞书会话列表" width="220" align="top" />
  &nbsp;
  <img src="images/img_readme_0.jpg" alt="飞书群聊中使用 ChatCCC" width="220" align="top" />
  &nbsp;
  <img src="images/img_readme_1.jpg" alt="思考过程和工具调用" width="220" align="top" />
</p>

---

## 为什么用 ChatCCC

- **手机上也能用 AI 编程工具**：在飞书或微信发消息，就像在终端给 Agent 下指令。
- **飞书体验更完整**：一群一会话、CardKit 卡片流式更新、支持群管理和多会话并行。
- **微信接入更轻**：不用创建飞书应用，启动后扫码即可在微信私聊里使用。
- **多 Agent 切换**：`/new` 使用默认 Agent，也可以用 `/new claude`、`/new cursor`、`/new codex` 指定工具。
- **群里能跑 git**：`/git status`、`/git pull`、`/git log` 会在当前会话工作目录执行，并把输出发回聊天窗口。

## 飞书和微信的差异

| 项目 | 飞书（推荐） | 微信 iLink |
| --- | --- | --- |
| 使用场景 | 长期主力使用 | 快速试用、临时远程控制 |
| 会话形态 | 群聊，一群一会话 | 私聊，一对一 |
| 消息展示 | CardKit 卡片，流式更新 | 纯文本，增量推送 |
| `/new` | 自动创建新群并绑定新会话 | 在当前私聊里创建新会话 |
| 多会话并行 | 直接切换不同群 | 支持并行，使用切换指令后未完成的任务会继续在后台进行，但不如飞书直观方便 |
| 群管理 | 支持创建、重命名、解散、头像 | 不支持 |
| 接入成本 | 需要配置飞书应用 | 启动后扫码登录 |

如果你主要在手机上长期控制 AI 编程工具，优先用飞书；如果只是想马上跑起来，微信更省配置。

---

## 怎么部署

### 1. 安装

#### npm 全局安装（推荐）

```bash
npm install -g chatccc
chatccc
```

要求 Node.js >= 20。安装完成后，在任意目录执行 `chatccc` 即可启动。配置、日志和状态文件会保存在包目录下的 `config.json`、`logs/`、`state/`。

首次启动时，如果还没有有效配置，ChatCCC 会自动打开本地 Web 配置向导（默认 `http://127.0.0.1:18080`）。

#### 从源码运行

```bash
git clone https://github.com/wzj998/ChatCCC.git
cd ChatCCC
npm install
npm run dev
```

### 2. 即时通讯软件配置

#### 飞书（推荐）

1. 打开 [飞书开放平台](https://open.feishu.cn)，创建一个**企业自建应用**。
2. 在「应用功能」里开启**机器人**能力。
3. 在「权限管理」里开通 `im:` 和 `cardkit:` 前缀下的相关权限：

| 前缀 | 用途 |
| --- | --- |
| `im:` | 收发消息、创建和管理群聊、机器人发言 |
| `cardkit:` | 卡片展示、流式更新、按钮和交互回调 |

<p align="center">
  <img src="images/img_readme_permission.png" alt="飞书应用权限配置" width="280" />
</p>

4. 在「事件与回调」里订阅 `im.message.receive_v1` 和 `card.action.trigger`。

<p align="center">
  <img src="images/img_readme_event.png" alt="飞书事件订阅" width="280" />
  &emsp;
  <img src="images/img_readme_callback.png" alt="飞书请求网址与回调" width="280" />
</p>

5. 创建应用版本并发布（企业内部可用即可）。
6. 在「凭证与基础信息」复制 **App ID** 和 **App Secret**，填入本地 Web 配置向导或 `config.json`。

如果你同时使用公司飞书和个人飞书，建议把个人账号放在另一个客户端里：安卓可用系统「应用双开」，iOS 可用 Lark。

#### 微信 iLink（可选）

微信模式不需要创建飞书应用。保持 `config.json` 里的 `platforms.ilink.enabled` 为 `true`（默认开启），启动 `chatccc` 后，终端会打印微信扫码登录二维码。

```bash
chatccc
# 控制台出现二维码后，用微信扫一扫登录
# 在微信里找到机器人，发送 /new 开始对话
```

微信登录信息会保存到 `state/ilink-auth.json`。token 过期后重新扫码即可。

### 3. AI 工具配置

ChatCCC 只负责把聊天消息转给本地 AI 工具，不捆绑这些 CLI。你只需要安装自己要用的 Agent。

#### Claude Code

如果使用官方 Claude Code，本机完成 Claude CLI 登录即可。若使用 DeepSeek 等 Anthropic 兼容网关，把 `claude.apiKey` 和 `claude.baseUrl` 填到 `config.json` 或 Web 配置向导。

#### Cursor Agent CLI

Windows 推荐安装：

```powershell
irm 'https://cursor.com/install?win32=true' | iex
agent login
```

验证：

```bash
agent --version
```

#### Codex CLI

```bash
npm install -g @openai/codex
codex login
codex --version
```

Codex 的默认模型和推理强度可继续由 `~/.codex/config.toml` 管理，也可以在 `config.json` 中覆盖。

### 4. `config.json`

`config.json` 不存在时，ChatCCC 会从 `config.sample.json` 复制一份。常用结构如下：

```json
{
  "feishu": {
    "appId": "cli_xxxxxxxxxxxx",
    "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxx"
  },
  "platforms": {
    "feishu": { "enabled": true },
    "ilink": { "enabled": true }
  },
  "port": 18080,
  "gitTimeoutSeconds": 180,
  "claude": {
    "enabled": false,
    "defaultAgent": true,
    "model": "claude-sonnet-4-6",
    "subagentModel": "",
    "effort": "",
    "apiKey": "",
    "baseUrl": ""
  },
  "cursor": {
    "enabled": false,
    "defaultAgent": false,
    "path": "",
    "model": ""
  },
  "codex": {
    "enabled": false,
    "defaultAgent": false,
    "path": "",
    "model": "",
    "effort": ""
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `feishu.appId` / `feishu.appSecret` | 飞书应用凭证 |
| `platforms.feishu.enabled` | 是否启用飞书 |
| `platforms.ilink.enabled` | 是否启用微信 iLink |
| `port` | 本地 Web 配置面板和中继服务端口 |
| `gitTimeoutSeconds` | `/git` 命令超时时间，默认 180 秒 |
| `*.enabled` | 是否启用对应 AI Agent |
| `*.defaultAgent` | `/new` 未指定 Agent 时使用哪个工具 |
| `cursor.path` / `codex.path` | CLI 可执行文件路径；留空时自动探测或使用 PATH |
| `claude.model` / `claude.subagentModel` | Claude Code 主模型 / subagent 模型；`subagentModel` 仅在第三方 API 模式下注入 `CLAUDE_CODE_SUBAGENT_MODEL` |
| `claude.apiKey` / `claude.baseUrl` | 第三方 Anthropic 兼容网关配置；官方 Claude 用户留空 |

> 当前 ChatCCC 以 `bypassPermissions` 模式运行，会跳过 Agent 操作确认。请只在可信环境中使用。

### 5. 开始使用

**飞书：** 找到你的机器人，发送 `/new`、`/new claude`、`/new cursor` 或 `/new codex`。机器人会创建一个新群并绑定 AI 会话，之后直接在群里聊天即可。

**微信：** 扫码登录后，在机器人私聊里发送 `/new` 或指定 Agent 的 `/new ...` 命令即可开始。功能与飞书基本一致，但展示为纯文本。

## 可用指令

| 指令 | 作用 |
| --- | --- |
| `/new` | 使用默认 Agent 创建新会话 |
| `/new claude` | 创建 Claude Code 会话 |
| `/new cursor` | 创建 Cursor 会话 |
| `/new codex` | 创建 Codex 会话 |
| `/newh` | 重置当前会话，保留工作目录 |
| `/stop` | 停止当前回复 |
| `/status` | 查看当前会话状态 |
| `/cd` | 查看或设置当前会话工作目录 |
| `/sessions` | 查看所有会话状态 |
| `/git <子命令>` | 在当前会话工作目录执行 `git ...` 并回传输出 |
| `/restart` | 重启机器人进程 |

---

## 技术栈

TypeScript / Node.js >= 20 / tsx / Anthropic Claude Agent SDK / Cursor Agent CLI / Codex CLI / 飞书 WebSocket API / CardKit / 微信 iLink
