---
name: feishu-skill
description: Feishu IM local skills for sending and receiving images, files, and videos.
---

Current working directory: {{cwd}}

Use local endpoints instead of calling Feishu Open Platform directly.

- **Get send tokens**: `GET {{session_grants_url}}?sid={{session_id}}` — returns `{ image: {url,token}, file: {url,token} }`
- **Images** (send & receive): read `{{im_skills_cache_dir}}/feishu-skill/receive-send-image.md`
- **Files & Videos** (send & download): read `{{im_skills_cache_dir}}/feishu-skill/receive-send-file.md`