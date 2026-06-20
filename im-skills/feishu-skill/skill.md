---
name: feishu-skill
description: Feishu IM local skills for sending and receiving images, files, and videos.
---

Current working directory: {{cwd}}

Use local endpoints instead of calling Feishu Open Platform directly.

- **Send images**: POST `{{send_image_url}}` with `{"session_id":"{{session_id}}","path":"<absolute path>","caption":"<optional>"}` — read `{{im_skills_cache_dir}}/feishu-skill/receive-send-image.md`
- **Send files/videos**: POST `{{send_file_url}}` with `{"session_id":"{{session_id}}","path":"<absolute path>","caption":"<optional>"}` — read `{{im_skills_cache_dir}}/feishu-skill/receive-send-file.md`
- **Delegate a task to a new agent conversation**: POST `{{delegate_task_url}}` with `{"tool":"codex|claude|cursor","cwd":"<absolute working directory>","open_id":"<Feishu user open_id>","prompt":"<first task>"}`. Use `open_ids` for multiple users. This uses the normal ChatCCC prompt flow, so project prompt injection and IM skills still apply.
