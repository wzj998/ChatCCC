---
name: wechat-video-skill
description: WeChat iLink local skills for sending and receiving videos.
---

Current working directory: {{cwd}}

WeChat videos are handled through the iLink SDK. The local server does NOT have HTTP RPC endpoints for WeChat; use the helper scripts below instead.

- **Receive videos**: Videos sent to the bot are automatically downloaded to `~/.chatccc/images/downloads/` with the filename prefix `wx_`. The message text will include the local path as `[视频] <absolute path>` — read `{{im_skills_cache_dir}}/wechat-video-skill/receive-send-video.md`
- **Send videos**: Use the send-video helper script — read `{{im_skills_cache_dir}}/wechat-video-skill/receive-send-video.md`