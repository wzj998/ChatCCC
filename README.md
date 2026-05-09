飞书聊天控制 Claude Code，未来支持 Cursor、Codex

# FeishuClauder

**飞书聊天控制 Claude Code，未来支持 Cursor、Codex**

---

## 解决的核心痛点

Claude Code 是命令行 AI 编程助手，能力很强，但你必须坐在电脑前开终端才能用。**离开电脑就没法用了。**

FeishuClauder 把 Claude Code 接入了飞书群聊：

- **手机上也能用 Claude Code** —— 在飞书群里发消息就等于在终端输入指令，Claude 的思考和回复会流式展示在群卡片里
- **团队共享会话** —— 群成员都能看到 Claude 的思考过程和结果，不需要屏幕共享或截图
- **流式打字机效果** —— 通过飞书 CardKit 实现思考内容的实时流式输出，不是一次性返回大段文字

一句话：**在任何设备上打开飞书，就能让 Claude 帮你写代码、排查问题、分析项目。**

---

## 怎么部署

### 1. 创建飞书应用

打开 [飞书开放平台](https://open.feishu.cn)，创建一个**企业自建应用**。

**添加应用能力**：开启「机器人」功能。

**权限配置**（在「权限管理」中搜索并开通以下权限）：

| 权限 | 用途 |
|------|------|
| `im:chat` | 创建和管理群聊 |
| `im:message` | 收发消息 |
| `im:message:send_as_bot` | 以机器人身份发消息 |
| `im:message.p2p_msg:readonly` | 读取私聊消息 |
| `im:message.group_msg:readonly` | 读取群聊消息 |

**事件订阅**（在「事件与回调」中）：订阅 `im.message.receive_v1` 和 `card.action.trigger` 事件。

**发布版本**：配置完成后创建应用版本并发布（仅企业内部可用即可）。

### 2. 获取凭证

在飞书应用详情页的「凭证与基础信息」中，复制 **App ID** 和 **App Secret**。

### 3. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`，填入上一步拿到的凭证：

```env
FEISHU_CLAUDER_APP_ID=cli_xxxxxxxxxxxx
FEISHU_CLAUDER_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 4. 安装依赖并启动

```bash
# 要求 Node.js >= 20
npm install
npm run dev
```

启动后机器人通过 WebSocket 连接飞书服务器，日志会写入 `logs/` 目录。

### 5. 开始使用

在飞书中找到你的机器人，发送 `/new`，机器人会自动创建一个群聊并把你的 Claude 会话绑定到该群。之后直接在群里发消息就能和 Claude 对话。

### 可用指令

| 指令 | 作用 |
|------|------|
| `/new` | 创建新的 Claude 会话（绑定一个新群聊） |
| `/stop` | 停止当前正在生成的回复 |
| `/status` | 查看当前会话的状态（轮数、模型、上下文 token 等） |
| `/cd` | 查看/切换工作目录 |
| `/restart` | 重启机器人进程 |

---

## 技术栈

TypeScript / Node.js >= 20 / tsx / Anthropic Claude Agent SDK / 飞书 WebSocket API / CardKit