---
name: wechat-file-skill
description: WeChat iLink local skill for sending and receiving files.
---

Current working directory: {{cwd}}

WeChat files are handled through the iLink SDK. The local server does NOT have HTTP RPC endpoints for WeChat; use the helper script below instead.

- **Receive files**: Files sent to the bot are automatically downloaded to `~/.chatccc/files/downloads/` with the filename prefix `wx_`. The message text will include the local path as `[文件] <absolute path>`.
- **Send files**: Use the send-file helper script — read `{{im_skills_cache_dir}}/wechat-file-skill/receive-send-file.md`
