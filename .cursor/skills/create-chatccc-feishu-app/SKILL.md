---
name: create-chatccc-feishu-app
description: Create, clone, or configure a Feishu enterprise self-built bot application for ChatCCC. Use when asked to create a ChatCCC Feishu app, imitate an existing lowercase `chatccc` app, prepare a bot for another computer, or configure its bot capability, `im:`/`cardkit:` permissions, events, credentials, version, and internal release from this repository's README.
---

# Create a ChatCCC Feishu App

Use the logged-in Feishu developer console to create and completely configure a ChatCCC bot app. Treat this repository's README as the minimum requirement and the existing app named exactly lowercase `chatccc` as the configuration template.

## 1. Establish the target and authorization

- Read the `README.md` section `#### 飞书（推荐）` before changing the console.
- Determine the requested app name, target computer, description, icon, availability, and whether the user wants configuration only or a real release. Derive a concise description when one is not supplied; for example, `用飞书聊天控制<目标电脑>上的 Claude Code / Cursor / Codex。`.
- Use the browser surface the user requested. If the user specifies Chrome DevTools/CDP, connect directly to `chromeDevtools.port` or the README default `15166`; do not substitute extension-based Chrome control.
- Obtain action-time confirmation before creating the app, granting permissions, saving event/callback subscriptions, or publishing. One explicit instruction such as `完整配置并真正发布` may authorize the listed actions as a batch.

## 2. Inventory the lowercase template

1. Open `https://open.feishu.cn/app?from=devbotmenu` in the authenticated browser.
2. Open the app named exactly lowercase `chatccc` in a separate tab.
3. Record its non-secret configuration:
   - app description and icon;
   - application capabilities, especially `机器人`;
   - every granted permission and its identity type;
   - event and callback subscription modes;
   - every event and callback identifier;
   - version availability, external sharing choices, and release state.
4. Never reveal, log, export to chat, or persist the template App Secret.

Prefer current console data over a stale hard-coded list. At the time this workflow was verified, lowercase `chatccc` had 62 application-identity permissions, one user-identity permission, 12 application events, and one callback. Use those counts as a sanity check, not as a replacement for inspecting the template.

## 3. Create the target app

1. Choose `创建企业自建应用` and fill the requested name and description.
2. Reuse the lowercase `chatccc` icon only when imitation was requested, and verify its crop preview.
3. Click the final `创建` action only after confirmation.
4. Click once and wait for SPA navigation. Verify the exact app name, App ID, URL, and status before retrying; the console can temporarily show stale text after a successful mutation.

## 4. Clone the complete ChatCCC configuration

Perform the configuration in this order:

1. Add the `机器人` application capability and verify that the page offers `删除能力`, which means the capability is enabled.
2. Clone permissions with `权限管理` > `批量处理` > `批量导入/导出权限`:
   - export from lowercase `chatccc`;
   - import into the target app;
   - confirm all additions and verify both application-identity and user-identity totals;
   - do not save the export JSON in the repository or chat.
3. Under `事件与回调` > `事件配置`, set the subscription mode to `使用长连接接收事件`, then add every event present in the template. The verified baseline is:
   - `im.chat.disbanded_v1`
   - `im.chat.member.bot.added_v1`
   - `im.chat.member.bot.deleted_v1`
   - `im.chat.member.user.added_v1`
   - `im.chat.member.user.deleted_v1`
   - `im.chat.member.user.withdrawn_v1`
   - `im.message.bot_muted_v1`
   - `im.message.message_read_v1`
   - `im.message.reaction.created_v1`
   - `im.message.reaction.deleted_v1`
   - `im.message.recalled_v1`
   - `im.message.receive_v1`
4. Under `回调配置`, independently set `使用长连接接收回调` and add `card.action.trigger`. Configuring the event mode does not configure the callback mode.
5. Verify that every listed event shows a sufficient permission as `已开通`.

The README minimum is the bot capability, relevant `im:` and `cardkit:` permissions, `im.message.receive_v1`, and `card.action.trigger`; a clone request requires the complete current template configuration, not only that minimum.

## 5. Create and publish a version

1. Open `版本管理与发布` and create a version such as `1.0.0`.
2. Keep mobile and desktop default abilities set to `机器人` and write a meaningful update note.
3. Match the requested or template availability. For a personal computer, default to the owner-only internal range and leave external group/private-chat sharing disabled unless explicitly requested.
4. Save the version, then complete the separate `确认发布` action. A successful version creation alone is not a release.
5. Refresh the version list and require all of the following evidence before reporting success:
   - application status `已启用`;
   - banner `当前修改均已发布`;
   - version status `已发布` with a publication time.
6. If administrator review is required, submit everything authorized and report the exact remaining approval state.

## 6. Verify and hand off safely

- Re-open the bot, permission, event/callback, and version pages after publication. Verify the bot is enabled, permission identity counts match, both subscription modes are long connection, event/callback identifiers match, and the version is published.
- Treat network responses and a refreshed page as stronger evidence than an immediately stale SPA view. Never repeat a create, add, or publish action only because the first page read is stale.
- Report the app name, App ID, capability, permission counts, event/callback counts, version, release state, and any remaining action.
- Never print the App Secret. If the user explicitly asks to configure ChatCCC, transfer the App ID and App Secret directly into the local private configuration without echoing the secret in commands, logs, screenshots, files tracked by Git, or chat.
- Do not modify local ChatCCC configuration or transmit credentials elsewhere unless explicitly authorized.
