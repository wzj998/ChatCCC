# ChatCCC

**飞书聊天控制 Claude Code，未来支持 Cursor、Codex**

---

## 解决的核心痛点

传统的 Claude Code（尤其是使用第三方 API 的，如 DeepSeek），需要坐在电脑桌前才能用。**离开电脑就没法用了。**

ChatCCC 把 Claude Code 接入了飞书群聊：

- **手机上也能用 Claude Code** —— 在飞书群里发消息就等于在终端输入指令，Claude 的思考和回复会流式展示在群卡片里
- **多会话并行** —— 一个群就是一个 Claude 会话，完全隔离、互不干扰，并行工作效率更高
- **体验丝滑** —— 思考过程完整，响应迅速

一句话：**在任何设备上打开飞书，就能让 Claude 帮你写代码、排查问题、分析项目。**

 

---

## 怎么部署

### 1. 安装

#### npm 全局安装（推荐）

```bash
npm install -g chatccc
```

要求 Node.js >= 20。安装完成后在项目目录创建 `.env`文件（参照.env.example文件），然后输入启动指令就启动了：

```bash
chatccc
```

#### 从源码安装

```bash
git clone https://github.com/wzj998/ChatCCC.git
cd ChatCCC
npm install
npm run dev
```

启动后机器人通过 WebSocket 连接飞书服务器，日志会写入 `logs/` 目录。

### 2. 创建飞书应用

打开 [飞书开放平台](https://open.feishu.cn)，创建一个**企业自建应用**。

**添加应用能力**：开启「机器人」功能。

**权限配置**（在「权限管理」中搜索并开通以下权限）：


| 权限                              | 用途        |
| ------------------------------- | --------- |
| `im:chat`                       | 创建和管理群聊   |
| `im:message`                    | 收发消息      |
| `im:message:send_as_bot`        | 以机器人身份发消息 |
| `im:message.p2p_msg:readonly`   | 读取私聊消息    |
| `im:message.group_msg:readonly` | 读取群聊消息    |


**事件订阅**（在「事件与回调」中）：订阅 `im.message.receive_v1` 和 `card.action.trigger` 事件。

**发布版本**：配置完成后创建应用版本并发布（仅企业内部可用即可）。

### 3. 获取凭证

在飞书应用详情页的「凭证与基础信息」中，复制 **App ID** 和 **App Secret**。

### 4. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`，填入上一步拿到的凭证：

```env
FEISHU_CLAUDER_APP_ID=cli_xxxxxxxxxxxx
FEISHU_CLAUDER_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxx
```

可选的高级配置：

```env
# Claude 模型（见下方优先级说明）
CHATCCC_ANTHROPIC_MODEL=dashscope/deepseek-v4-pro-anthropic

# 思考深度，可选值: low | medium | high | max
CHATCCC_ANTHROPIC_EFFORT=max
```

`**CHATCCC_ANTHROPIC_MODEL` 优先级**：环境变量设置的值 > 代码内默认值 `dashscope/deepseek-v4-pro-anthropic`。不设或设为空白时自动使用默认模型。

`**CHATCCC_ANTHROPIC_EFFORT` 优先级**：环境变量设置的值 > 代码内默认值 `max`。

`**CHATCCC_PORT` 端口配置**：默认端口为 `18080`。如果你需要在一台机器上同时运行多个 ChatCCC 实例（例如用不同飞书应用分别接入不同项目），可以在各自的 `.env` 中设置不同的端口：

```env
# 实例 A（项目1）的 .env
CHATCCC_PORT=18080

# 实例 B（项目2）的 .env
CHATCCC_PORT=18081
```

不同端口的实例互不冲突，启动时会自动清理各自端口上的旧进程。

> **权限说明**：目前 ChatCCC 以 `bypassPermissions` 模式运行，即跳过所有权限确认、允许所有操作。后续会考虑引入细粒度权限控制，让你可以按需放行特定操作。

> **Linux 用户注意**：不能将项目装在 `/root` 目录下运行。

### 5. 开始使用

在飞书中找到你的机器人，发送 `/new`，机器人会自动创建一个群聊并把你的 Claude 会话绑定到该群。之后直接在群里发消息就能和 Claude 对话。

### 可用指令


| 指令         | 作用                           |
| ---------- | ---------------------------- |
| `/new`     | 创建新的 Claude 会话（绑定一个新群聊）      |
| `/stop`    | 停止当前正在生成的回复                  |
| `/status`  | 查看当前会话的状态（轮数、模型、上下文 token 等） |
| `/cd`      | 查看/切换工作目录                    |
| `/restart` | 重启机器人进程                      |


---

## 技术栈

TypeScript / Node.js >= 20 / tsx / Anthropic Claude Agent SDK / 飞书 WebSocket API / CardKit