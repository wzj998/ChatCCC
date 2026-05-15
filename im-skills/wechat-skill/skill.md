---
name: wechat-skill
description: WeChat iLink local skills for sending and receiving images, files, and videos.
---

Current working directory: {{cwd}}

WeChat media is handled through the iLink SDK. The local server does NOT have HTTP RPC endpoints for WeChat; use the helper scripts below instead.

- **Receive images**: Images sent to the bot are automatically downloaded to `~/.chatccc/images/downloads/` with the filename prefix `wx_`. The message text will include the local path as `[图片] <absolute path>` — read `{{im_skills_cache_dir}}/wechat-skill/receive-send-image.md`
- **Send images**: Use the send-image helper script — read `{{im_skills_cache_dir}}/wechat-skill/receive-send-image.md`
- **Receive files**: Files sent to the bot are automatically downloaded to `~/.chatccc/images/downloads/` with the filename prefix `wx_`. The message text will include the local path as `[文件] <absolute path>` — read `{{im_skills_cache_dir}}/wechat-skill/receive-send-file.md`
- **Send files**: Use the send-file helper script — read `{{im_skills_cache_dir}}/wechat-skill/receive-send-file.md`
- **Receive videos**: Videos sent to the bot are automatically downloaded to `~/.chatccc/images/downloads/` with the filename prefix `wx_`. The message text will include the local path as `[视频] <absolute path>` — read `{{im_skills_cache_dir}}/wechat-skill/receive-send-video.md`
- **Send videos**: Use the send-video helper script — read `{{im_skills_cache_dir}}/wechat-skill/receive-send-video.md`