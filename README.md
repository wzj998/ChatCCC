# ChatCCC

**飞书聊天控制 Claude Code / Cursor，未来支持 Codex**

---

## 解决的核心痛点

传统的 Claude Code（尤其是使用第三方 API 的，如 DeepSeek），需要坐在电脑桌前才能用。**离开电脑就没法用了。**

ChatCCC 把 Claude Code 和 Cursor Agent 接入了飞书群聊：

- **手机上也能用 Claude Code / Cursor** —— 在飞书群里发消息就等于在终端输入指令，AI 的思考和回复会流式展示在群卡片里
- **多会话并行** —— 一个群就是一个 AI 会话，完全隔离、互不干扰，并行工作效率更高
- **多工具切换** —— `/new claude` 创建 Claude Code 会话，`/new cursor` 创建 Cursor 会话，各取所长

一句话：**在任何设备上打开飞书，就能让 Claude Code 或 Cursor 帮你写代码、排查问题、分析项目。**

<p align="center">
  <img src="images/img_readme_0.jpg" alt="飞书群聊中使用 ChatCCC" width="280" />
  &emsp;
  <img src="images/img_readme_1.jpg" alt="思考过程和工具调用" width="280" />
</p>

---

## 为什么选 ChatCCC

- **一群一会话，心智最简单** —— `/new` 直接建一个新飞书群，群本身就是 AI 会话上下文。换会话就是换群，没有 thread / 子话题概念，手机端切换最直观
- **零配置成本** —— 只用 `.env`，没有 TOML、没有 Web 后台。`npm i -g chatccc` 后 `cd` 到项目目录直接 `chatccc` 就跑
- **群里能跑 git** —— `/git status`、`/git pull`、`/git log` 在飞书群里直接执行 stdout/stderr 回发，不用回电脑
- **代码极简易改** —— 纯 TypeScript 实现，核心只有 20 多个文件，统一 `ToolAdapter` 接口屏蔽 Claude / Cursor 差异，看得懂、改得动

---

## 怎么部署

### 1. 安装

#### npm 全局安装（推荐）

```bash
npm install -g chatccc
```

要求 Node.js >= 20。安装完成后，**先进入你的项目根目录**（该目录里应有 `src/`、`.env`，可参照 `.env.example` 创建 `.env`），再启动：

```bash
cd /path/to/your/project   # Windows 示例: cd D:\code\ChatCCC
chatccc
```

所有相对路径（`.env`、`src/index.ts`）都相对**当前终端所在目录**。若在用户主目录（如 `C:\Users\1`）执行，会出现 `.env: not found` 或找不到 `src/index.ts`。

若不用全局命令、改用 tsx 直接跑，同样要在项目根目录执行：

```bash
cd /path/to/your/project
npx tsx --env-file=.env src/index.ts
```

#### 从源码安装

```bash
git clone https://github.com/wzj998/ChatCCC.git
cd ChatCCC
npm install
npm run dev
```

启动后机器人通过 WebSocket 连接飞书服务器，日志会写入 `logs/` 目录。

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

验证是否已安装（任一可用即可）：

```bash
agent --version
cursor-agent --version
```

ChatCCC 启动时会按以下顺序探测 Cursor Agent CLI：

1. 环境变量 `CHATCCC_CURSOR_COMMAND` 指定的路径（若已设置）
2. Windows 上 Cursor IDE 默认安装位置 `%LOCALAPPDATA%\cursor-agent\agent.cmd`（自动识别）
3. PATH 中的 `agent` 命令

若以上都找不到，或你想用一个非默认的可执行文件（例如 `cursor-agent`），在 `.env` 中显式指定：

```env
CHATCCC_CURSOR_COMMAND=/path/to/agent
```

> 高级用户如需覆盖默认 CLI 参数，可设置 `CHATCCC_CURSOR_ARGS`，一般无需修改。

> **说明**：只使用 Claude Code（`/new claude` 或 `/new`）的用户无需安装 Cursor CLI。

### 2. 创建飞书应用

打开 [飞书开放平台](https://open.feishu.cn)，创建一个**企业自建应用**。

**添加应用能力**：开启「机器人」功能。

**权限配置（重要）**（在「权限管理」中按前缀搜索，**将以下三类前缀开头的权限全部开通**）：

| 前缀 | 用途（简要） |
| ---- | ------------ |
| `im:message` | 收发与读取消息、以机器人身份发言、与会话相关的消息能力等 |
| `im:chat` | 创建与管理群聊、与会话绑定、群成员与聊天场景相关能力等 |
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

### 4. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`，填入上一步拿到的凭证：

```env
CHATCCC_APP_ID=cli_xxxxxxxxxxxx
CHATCCC_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxx
```

若你曾使用旧版变量名 `FEISHU_CLAUDER_APP_ID` / `FEISHU_CLAUDER_APP_SECRET`，请改为上表中的 `CHATCCC_APP_ID` / `CHATCCC_APP_SECRET`。

可选：Claude 模型与思考深度：

```env
# 网关或服务商文档中的 model；设为 default（任意大小写）或不写则交给 SDK/CLI 默认
CHATCCC_ANTHROPIC_MODEL=default

# 如 low / medium / high / max；设为 default（任意大小写）或不写则不向 SDK 传入 effort
CHATCCC_ANTHROPIC_EFFORT=max
```

Cursor Agent CLI 模型（仅 Cursor 会话相关，省略或 `default` 时不传 `--model`）：

```env
# Cursor 会话实际使用的模型 ID（如 claude-opus-4-7-max / claude-opus-4-7-thinking-max 等）
# 可用 `agent --list-models` 查看所有支持的模型 ID
CHATCCC_CURSOR_MODEL=claude-opus-4-7-max

# 高级用户可覆盖默认 CLI 参数（一般无需修改）
# CHATCCC_CURSOR_ARGS=-p --force --output-format stream-json --stream-partial-output
```

#### 注意！第三方 API（如 DeepSeek）与鉴权 403

若你通过 **Anthropic 兼容网关**（例如 DeepSeek 的 `/anthropic` 端点）调用模型，除了官方 Claude 以外，需要配置 **`ANTHROPIC_API_KEY`**（API 密钥）与 **`ANTHROPIC_BASE_URL`**（写入系统环境变量，见下表）。

不少用户会把这些写在 **`~/.claude/settings.json`**（Windows 一般为 `C:\Users\<用户名>\.claude\settings.json`）的 `env` 字段里，供本机 **交互式 Claude Code** 使用。但 **Claude Agent SDK 在启动时拉起的是子进程**，其行为与直接打开终端跑 Claude Code 并不完全一致，**子进程未必会按你预期读取 `.claude` 目录下 `settings.json` 里的 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL` 等**，从而出现类似：

`Failed to authenticate. API Error: 403 Request not allowed`

**建议（最稳妥）**：把 **`ANTHROPIC_BASE_URL`** 与 **`ANTHROPIC_API_KEY`**（API 密钥）写进 **操作系统环境变量**（当前用户的「用户变量」即可，一般无需管理员），例如：

| 变量名 | 说明 |
| ------ | ---- |
| `ANTHROPIC_API_KEY` | 在服务商控制台获取的 **API 密钥**，填入本环境变量。Anthropic 兼容网关普遍使用该名称；若服务商文档要求使用其它环境变量名，以文档为准。 |
| `ANTHROPIC_BASE_URL` | 兼容 Anthropic API 的 base URL，例如 DeepSeek：`https://api.deepseek.com/anthropic` |

若你在 `settings.json` 里还为 Sonnet/Haiku/Opus 配置了默认模型名，可一并同步到用户环境变量（如 `ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_SONNET_MODEL` 等），与文档及网关要求保持一致。

修改环境变量后，请 **完全退出并重新打开** 终端、IDE（如 Cursor）以及 ChatCCC 进程，再试飞书对话或本地 `npm run demo:claude-hi`，确保子进程继承到新变量。

在 **Windows** 上可用 PowerShell 写入当前用户的持久变量（示例，请把第二行里的字符串换成你在服务商控制台复制的 **API 密钥**，即 **`ANTHROPIC_API_KEY`** 的值）：

```powershell
[Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", "https://api.deepseek.com/anthropic", "User")
[Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "你的_API_密钥", "User")
```

也可在 **系统属性 → 环境变量** 中手动添加。Linux / macOS 可将 `export` 写入 `~/.bashrc`、`~/.zshrc` 等，或使用 systemd、`launchctl` 等按你的部署方式注入。

> **说明**：项目根目录的 `.env` 若通过 `tsx --env-file=.env` 加载，其中的变量会进入 Node 进程环境，**多数情况下**会随进程继承给 SDK 子进程；但各家网关与 Claude Code 版本组合较多，**仍推荐**将 **`ANTHROPIC_API_KEY`** 与 **`ANTHROPIC_BASE_URL`** 放在系统/用户环境变量中，与 `settings.json` 形成双保险，避免仅依赖 `.claude/settings.json` 时在 SDK 场景下踩坑。

**`CHATCCC_PORT`（可选）**：默认端口为 `18080`。若在一台机器上同时运行多个 ChatCCC 实例，可在各自的 `.env` 中设置不同端口：

```env
# 实例 A（项目1）的 .env
CHATCCC_PORT=18080

# 实例 B（项目2）的 .env
CHATCCC_PORT=18081
```

不同端口的实例互不冲突，启动时会自动清理各自端口上的旧进程。

**`CHATCCC_GIT_TIMEOUT_SECONDS`（可选）**：`/git <子命令>` 在会话工作目录执行 git 命令时的单次超时秒数，默认 `180`，允许范围 `1–3600`。配置非法（非整数、越界等）时启动日志会标红提示并回退为默认值；命令超时则会被 `SIGKILL` 强制终止，并把已收集到的输出（带「⏱️ 命令超时被强制终止」标记）回发到群里。

```env
# 调高到 600 秒，适合 git fsck、git gc 等耗时操作
CHATCCC_GIT_TIMEOUT_SECONDS=600
```

> **权限说明**：目前 ChatCCC 以 `bypassPermissions` 模式运行，即跳过所有权限确认、允许所有操作。后续会考虑引入细粒度权限控制，让你可以按需放行特定操作。

> **Linux 用户注意**：不能将项目装在 `/root` 目录下运行。

### 5. 开始使用

在飞书中找到你的机器人，发送 `/new`（默认 Claude Code）或 `/new claude` / `/new cursor`，机器人会自动创建一个群聊并把 AI 会话绑定到该群。之后直接在群里发消息就能对话。

### 可用指令


| 指令            | 作用                           |
| --------------- | ---------------------------- |
| `/new`          | 创建新的 Claude Code 会话（默认）    |
| `/new claude`   | 创建新的 Claude Code 会话          |
| `/new cursor`   | 创建新的 Cursor 会话               |
| `/stop`         | 停止当前正在生成的回复                  |
| `/status`       | 查看当前会话的状态（轮数、模型、上下文 token 等） |
| `/cd`           | 查看/切换工作目录                    |
| `/sessions`     | 查看所有会话状态                    |
| `/git <子命令>` | 在**当前会话工作目录**执行 `git ...` 并把 stdout/stderr 回发到群里（仅会话群内可用，超时见 `CHATCCC_GIT_TIMEOUT_SECONDS`） |
| `/restart`      | 重启机器人进程                      |


---

## 技术栈

TypeScript / Node.js >= 20 / tsx / Anthropic Claude Agent SDK / Cursor Agent CLI / 飞书 WebSocket API / CardKit