---
name: wechat-file-skill
description: WeChat iLink local skills for sending and receiving files.
---

Current working directory: {{cwd}}

WeChat files are handled through the iLink SDK. The local server does NOT have HTTP RPC endpoints for WeChat; use the helper scripts below instead.

- **Receive files**: Files sent to the bot are automatically downloaded to `~/.chatccc/images/downloads/` with the filename prefix `wx_`. The message text will include the local path as `[文件] <absolute path>` — read `{{im_skills_cache_dir}}/wechat-file-skill/receive-send-file.md`
- **Send files**: Use the send-file helper script — read `{{im_skills_cache_dir}}/wechat-file-skill/receive-send-file.md`