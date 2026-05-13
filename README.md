# ChatCCC

**飞书（Lark）聊天控制 Claude Code / Cursor / Codex**

---

## 解决的核心痛点

传统的 Claude Code（尤其是使用第三方 API 的，如 DeepSeek），需要坐在电脑桌前才能用。**离开电脑就没法用了。**

ChatCCC 把 Claude Code、Cursor Agent、Codex (OpenAI) 接入了飞书群聊：

- **手机上也能用 Claude Code / Cursor / Codex** —— 在飞书群里发消息就等于在终端输入指令，AI 的思考和回复会流式展示在群卡片里
- **多会话并行** —— 一个群就是一个 AI 会话，完全隔离、互不干扰，并行工作效率更高
- **多工具切换** —— `/new` 使用默认 Agent 创建会话，也可用 `/new claude`、`/new cursor`、`/new codex` 指定工具，各取所长

一句话：**在任何设备上打开飞书，就能让 Claude Code / Cursor / Codex 帮你写代码、排查问题、分析项目。**

<p align="center">
  <img src="images/img_readme_messages.jpg" alt="飞书会话列表" width="220" align="top" />
  &nbsp;
  <img src="images/img_readme_0.jpg" alt="飞书群聊中使用 ChatCCC" width="220" align="top" />
  &nbsp;
  <img src="images/img_readme_1.jpg" alt="思考过程和工具调用" width="220" align="top" />
</p>

---

## 为什么选 ChatCCC

- **一群一会话，心智最简单** —— `/new` 直接建一个新飞书群，群本身就是 AI 会话上下文。换会话就是换群，没有 thread / 子话题概念，手机端切换最直观
- **零配置成本** —— 单一 `config.json`，没有 TOML 也没有零散环境变量。`npm i -g chatccc` 后**任意目录**直接 `chatccc` 就跑，首次启动自动弹出本地 Web 配置向导
- **群里能跑 git** —— `/git status`、`/git pull`、`/git log` 在飞书群里直接执行 stdout/stderr 回发，不用回电脑
- **代码极简易改** —— 纯 TypeScript 实现，核心只有 20 多个文件，统一 `ToolAdapter` 接口屏蔽 Claude / Cursor / Codex 差异，看得懂、改得动

---

## 怎么部署

### 1. 安装

#### npm 全局安装（推荐）

```bash
npm install -g chatccc
```

要求 Node.js >= 20。安装完成后，**在任意目录**直接启动即可：

```bash
chatccc
```

> ChatCCC 的所有数据（`config.json`、`logs/`、`state/`）都保存在 npm 包安装目录下，与你当前终端所在目录无关。**不需要先 `cd` 到任何特定目录。**

首次启动时若 `config.json` 还没有有效凭证，会自动起一个本地 Web 配置向导（默认 `http://127.0.0.1:18080`），用浏览器把飞书 App ID / App Secret 等填进去，保存即开始运行。

> 已在运行的实例，启动完成后控制台底部 banner 也会打印「配置面板」地址，随时可以打开浏览器查看状态、修改配置（多数改动无需重启即可生效）。停止 / 重启请通过页面顶部按钮或终端 `Ctrl+C`，**面板上不再提供"启动"按钮**——服务停止后页面随进程退出，需要回到终端重新执行 `chatccc`。

#### 从源码安装

```bash
git clone https://github.com/wzj998/ChatCCC.git
cd ChatCCC
npm install
npm run dev
```

启动后机器人通过 WebSocket 连接飞书服务器，日志会写入仓库根目录下的 `logs/`。

#### Cursor Agent CLI（使用 Cursor 会话时需要）

ChatCCC **不捆绑** Cursor Agent CLI，需要用户自行安装。

**推荐安装方式（Windows）：**

在 PowerShell 中执行：

```powershell
irm 'https://cursor.com/install?win32=true' | iex
```

安装完成后 `agent` 命令会出现在系统 PATH 中。

**其他安装方式：**

1. **Cursor IDE 自带**：安装 [Cursor IDE](https://cursor.com) 后，部分版本会自带 `agent` 或 `cursor-agent` 命令
2. **独立安装**：Cursor 正在逐步提供独立的 CLI 安装方式

安装后需登录 Cursor 账号：

```bash
agent login
```

验证是否已安装（任一可用即可）：

```bash
agent --version
cursor-agent --version
```

ChatCCC 启动时会按以下顺序确定 Cursor Agent CLI：

1. `config.json` 中的 `cursor.path` 指定的路径（若已配置）
2. Windows 上 Cursor IDE 默认安装位置 `%LOCALAPPDATA%\cursor-agent\agent.cmd`（自动识别）
3. PATH 中的 `agent` 命令

> 首次启动 ChatCCC 时，如果 `config.json` 不存在，会从 `config.sample.json` 复制一份并**立即探测一次** Cursor / Codex CLI 的绝对路径，命中就写入 `cursor.path` / `codex.path`，无须手动编辑。

若想强制使用某个非默认的可执行文件（例如 `cursor-agent` 而不是 `agent`），可在 `config.json` 中显式指定：

```json
{
  "cursor": {
    "path": "/path/to/agent"
  }
}
```

> 旧版字段 `cursor.command` 仍可读取（启动时会打印一次 warning 提示改名），新配置请统一使用 `cursor.path`。

> **说明**：只使用 Claude Code（`/new claude`，或把 Claude Code 设为默认 Agent 后使用 `/new`）的用户无需安装 Cursor CLI。

#### Codex CLI（使用 Codex 会话时需要）

ChatCCC **不捆绑** Codex CLI，需要用户自行安装：

```bash
npm install -g @openai/codex
```

安装后需登录 OpenAI 账号：

```bash
codex login
```

验证是否已安装：

```bash
codex --version
```

Codex 会话的模型和努力程度由 `config.toml`（`~/.codex/config.toml`）决定，也可在 `config.json` 中显式覆盖：

```json
{
  "codex": {
    "path": "",
    "model": "",
    "effort": ""
  }
}
```

- `codex.path`：留空时直接调用 PATH 中的 `codex`；可填绝对路径指向自定义可执行文件（首次创建 `config.json` 时会自动探测并填入）
- `codex.model`：留空时由 `~/.codex/config.toml` 决定
- `codex.effort`：留空时由 `~/.codex/config.toml` 决定（通过 `-c model_reasoning_effort` 传递）

> 旧版字段 `codex.command` 仍可读取（启动时会打印一次 warning 提示改名），新配置请统一使用 `codex.path`。

> **说明**：只使用 Claude Code 或 Cursor 的用户无需安装 Codex CLI。

### 2. 创建飞书应用

打开 [飞书开放平台](https://open.feishu.cn)，创建一个**企业自建应用**。

> **第一步：添加机器人（千万别忘！）**
>
> 创建应用后，立刻在「应用功能」中开启「机器人」能力。没有机器人，就根本找不到哪里和这个机器人对话，整个 ChatCCC 无法工作。

**权限配置（重要）**（在「权限管理」中按前缀搜索，**将以下两类前缀开头的权限全部开通**）：

| 前缀 | 用途（简要） |
| ---- | ------------ |
| `im:` | 收发消息、创建与管理群聊、以机器人身份发言等（请将此前缀下所有权限全部开通） |
| `cardkit:` | 群卡片展示、流式更新、卡片按钮与交互回调相关能力等 |

控制台中同一前缀下往往有多条子权限，请逐项勾选开通，避免遗漏导致收不到消息或卡片异常。

<p align="center">
  <img src="images/img_readme_permission.png" alt="飞书应用权限配置" width="280" />
</p>

**事件订阅（重要）**（在「事件与回调」中）：订阅 `im.message.receive_v1` 和 `card.action.trigger` 事件。

<p align="center">
  <img src="images/img_readme_event.png" alt="飞书事件订阅" width="280" />
  &emsp;
  <img src="images/img_readme_callback.png" alt="飞书请求网址与回调" width="280" />
</p>

**发布版本（不要忘了）**：配置完成后创建应用版本并发布（仅企业内部可用即可）。

### 3. 获取凭证

在飞书应用详情页的「凭证与基础信息」中，复制 **App ID** 和 **App Secret**。

### 4. 配置 `config.json`

ChatCCC 的所有运行参数都集中在包根目录的 `config.json`。

#### 推荐：用 Web 配置向导（首次启动自动弹出）

第一次运行 `chatccc` 时，如果 `config.json` 还没有有效凭证，会自动起一个本地 Web 服务（默认 `http://127.0.0.1:18080`）。在浏览器里把上一步拿到的 **App ID** / **App Secret** 等填进去，保存即写入 `config.json`，进程立即继续启动飞书 WebSocket。

#### 备选：手动编辑 `config.json`

`config.json` 不存在时，ChatCCC 会从 `config.sample.json` 复制一份，结构如下：

```json
{
  "feishu": {
    "appId": "cli_xxxxxxxxxxxx",
    "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxx"
  },
  "port": 18080,
  "gitTimeoutSeconds": 180,
  "claude": {
    "enabled": false,
    "defaultAgent": true,
    "model": "",
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

各字段含义：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `feishu.appId` / `feishu.appSecret` | 是 | 飞书应用「凭证与基础信息」中的 App ID / App Secret |
| `port` | 否 | 本地 WebSocket 中继 + Web 向导监听端口，默认 `18080`；同机多实例时改成不同值即可 |
| `gitTimeoutSeconds` | 否 | `/git` 命令在会话工作目录执行时的单次超时秒数，默认 `180`，允许范围 `1–3600`，超时会被 `SIGKILL` 强制终止 |
| `claude.enabled` / `cursor.enabled` / `codex.enabled` | 否 | 是否启用对应 AI Agent；Web 向导/管理页只展示 `enabled: true` 的 agent 卡片。字段缺省时按「任一配置字段非空」自动判定（向后兼容） |
| `claude.defaultAgent` / `cursor.defaultAgent` / `codex.defaultAgent` | 否 | `/new` 未指定具体 Agent 时使用哪个默认 Agent；同一时间应只有一个为 `true`。Web 配置页切换某个 Agent 为默认时会自动关闭其它 Agent 的默认开关 |
| `claude.model` | 否 | Claude Code 会话使用的模型；留空（`""` / 全空白）→ 不向 SDK 传 `model`，由 SDK / 服务商默认决定 |
| `claude.effort` | 否 | Claude 思考深度（如 `low` / `medium` / `high` / `max`）；留空 → 不向 SDK 传 `effort` |
| `claude.apiKey` | 否 | 第三方 Anthropic 兼容网关的 API 密钥；**官方 Claude 用户保持 `""` 即可**，详见下文「第三方 API」一节 |
| `claude.baseUrl` | 否 | 第三方 Anthropic 兼容网关的 base URL（例如 `https://api.deepseek.com/anthropic`）；**官方 Claude 用户保持 `""` 即可** |
| `cursor.model` | 否 | Cursor 会话使用的模型 ID（如 `claude-opus-4-7-max`）；留空时不传 `--model`，可用 `agent --list-models` 查看支持的模型 |
| `codex.model` | 否 | Codex 会话使用的模型；留空时由 `~/.codex/config.toml` 决定 |
| `codex.effort` | 否 | Codex 努力程度（`low` / `medium` / `high`）；留空时由 `~/.codex/config.toml` 决定 |

> `claude.model` / `claude.effort` 的旧值 `"default"` 仍兼容，启动时会按留空处理并打印一次 warning，请尽快改成 `""`。

> `cursor.path` / `codex.path` 由首次启动时的自动探测填入，一般无需手动修改。

#### 第三方 API（如 DeepSeek）：填 `claude.apiKey` 与 `claude.baseUrl`

若你通过 **Anthropic 兼容网关**（例如 DeepSeek 的 `/anthropic` 端点）调用模型，需要把网关凭证填到 `config.json` 的 `claude.apiKey` 与 `claude.baseUrl`。**官方 Claude 用户**（本机已通过 `claude` CLI 完成 OAuth 登录）保持这两项 `""` 即可，无需任何额外配置。

两条等价的填写路径：

**1. Web 配置向导（推荐）**

打开 `http://127.0.0.1:18080`（首次启动自动弹出，已在运行的实例也可手动访问），在「Claude Agent」一节顶部把「API 来源」从 **官方 API（Anthropic 直连）** 切换到 **第三方 API（自定义网关）**——切换后会出现 API Key / Base URL 两个输入框，填进去保存即可。**切回官方模式后保存，已填的密钥会被自动清空**，不会残留在 `config.json` 中。

**2. 直接编辑 `config.json`**

```json
{
  "claude": {
    "model": "",
    "effort": "",
    "apiKey": "你的_API_密钥",
    "baseUrl": "https://api.deepseek.com/anthropic"
  }
}
```

> ChatCCC 不会把这两个值写入主进程的环境变量；它们仅在调用 Claude Agent SDK 时被注入到 SDK 拉起的子进程，跟主进程 env 完全隔离。两项留空 / 缺失时，子进程沿用主进程默认的鉴权行为（即官方 Claude 的 OAuth）。

> 所有运行参数（端口、`/git` 超时、各 AI 工具模型 / 路径等）都在第 4 节展示的 `config.json` 里配置，不再使用 `CHATCCC_*` 环境变量。多实例共存只需在每个实例的 `config.json` 里把 `port` 设为不同值即可（例如 `18080` / `18081`），ChatCCC 启动时会自动清理各自端口上的旧进程。

> **权限说明**：目前 ChatCCC 以 `bypassPermissions` 模式运行，即跳过所有权限确认、允许所有操作。后续会考虑引入细粒度权限控制，让你可以按需放行特定操作。

> **Linux 用户注意**：不能将项目装在 `/root` 目录下运行。

### 5. 开始使用

在飞书中找到你的机器人，发送 `/new`（使用 `config.json` 中 `defaultAgent: true` 的默认 Agent）或 `/new claude` / `/new cursor` / `/new codex`，机器人会自动创建一个群聊并把 AI 会话绑定到该群。之后直接在群里发消息就能对话。

### 可用指令


| 指令            | 作用                           |
| --------------- | ---------------------------- |
| `/new`          | 使用默认 Agent 创建新会话            |
| `/new claude`   | 创建新的 Claude Code 会话          |
| `/new cursor`   | 创建新的 Cursor 会话               |
| `/new codex`    | 创建新的 Codex 会话（OpenAI）         |
| `/stop`         | 停止当前正在生成的回复                  |
| `/status`       | 查看当前会话的状态（轮数、模型、上下文 token 等） |
| `/cd`           | 查看/设置当前会话的默认工作目录            |
| `/sessions`     | 查看所有会话状态                    |
| `/forget`       | 重置当前会话（创建新 Session，保留工作目录，同一群内继续） |
| `/git <子命令>` | 在**当前会话工作目录**执行 `git ...` 并把 stdout/stderr 回发到群里（仅会话群内可用，超时见 `config.json` 的 `gitTimeoutSeconds` 字段） |
| `/restart`      | 重启机器人进程                      |


---

## 飞书操作流程

### 同时使用公司飞书和个人飞书

如果你既要在公司飞书中使用 ChatCCC，又想用个人飞书账号，同一台手机无法同时登录两个飞书账号。推荐以下方案：

**方案一：安卓手机**

使用系统的「应用双开」功能，把飞书复制一份。原版飞书登录公司账号，飞书复制版登录个人飞书账号，两个飞书可以同时在线、互不干扰。

**方案二：苹果手机**

在 App Store 下载「飞书国际版（Lark）」。原版飞书登录公司账号，Lark 登录个人飞书账号，两个 App 互相独立、可同时在线。

---

## 技术栈

TypeScript / Node.js >= 20 / tsx / Anthropic Claude Agent SDK / Cursor Agent CLI / Codex CLI (OpenAI) / 飞书 WebSocket API / CardKit
