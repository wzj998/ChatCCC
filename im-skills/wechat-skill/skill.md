---
name: wechat-skill
description: WeChat iLink local skills for sending and receiving images.
---

Current working directory: {{cwd}}

WeChat images are handled through the iLink SDK. The local server does NOT have HTTP RPC endpoints for WeChat; use the helper scripts below instead.

- **Receive images**: Images sent to the bot are automatically downloaded to `~/.chatccc/images/downloads/` with the filename prefix `wx_`. The message text will include the local path as `[图片] <absolute path>`.
- **Send images**: Use the send-image helper script — read `{{im_skills_cache_dir}}/wechat-skill/receive-send-image.md`