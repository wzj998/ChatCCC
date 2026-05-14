---
name: feishu-skill
description: Feishu IM local skills for sending and receiving images, files, and videos.
---

Current working directory: {{cwd}}

Use local endpoints instead of calling Feishu Open Platform directly.

- **Send images**: POST `{{send_image_url}}` with `{"session_id":"{{session_id}}","path":"<absolute path>","caption":"<optional>"}` — read `{{im_skills_cache_dir}}/feishu-skill/receive-send-image.md`
- **Send files/videos**: POST `{{send_file_url}}` with `{"session_id":"{{session_id}}","path":"<absolute path>","caption":"<optional>"}` — read `{{im_skills_cache_dir}}/feishu-skill/receive-send-file.md`