---
name: feishu-skill
description: Feishu IM local skills for sending images, files, videos, and for creating new sessions or switching working directories.
---

Current working directory: {{cwd}}
Your session id: {{session_id}}
Your session capability grant: {{agent_capability_grant}}
Your Feishu open_id: {{open_id}}

Use local endpoints instead of calling Feishu Open Platform directly.

- **Send images**: POST `{{send_image_url}}` with `{"session_id":"{{session_id}}","grant":"{{agent_capability_grant}}","path":"<absolute path>","caption":"<optional>"}` — read `{{im_skills_cache_dir}}/feishu-skill/receive-send-image.md`
- **Send files/videos**: POST `{{send_file_url}}` with `{"session_id":"{{session_id}}","grant":"{{agent_capability_grant}}","path":"<absolute path>","caption":"<optional>"}` — read `{{im_skills_cache_dir}}/feishu-skill/receive-send-file.md`
- **Create a new session (新建会话)**: POST `{{delegate_task_url}}` with `{"tool":"claude|cursor|codex|ccc|dsh","cwd":"<absolute path>","open_id":"{{open_id}}","prompt":"<optional first task>"}`. This creates a new Feishu group and session, and only adds you (the requester). `tool` and `prompt` are optional; omit `prompt` to just create the session without a first task.
- **Set default working directory (cd / 切换目录)**: POST `{{set_cwd_url}}` with `{"session_id":"{{session_id}}","dir":"<absolute path>"}`. This sets the default directory for future new sessions only; it does not change the current session.

How to map user requests to these endpoints:

- "新建会话 / 开个新会话 / 换个新会话" → create a new session (no prompt). Use `cwd` = your current working directory ({{cwd}}) unless the user names a directory.
- "在 <目录> 新建会话（做 <任务>）" → create a new session with `cwd` = that directory, and set `prompt` to the task if one was given.
- "cd 到 <目录> / 切换到 <目录> / 去 <目录> 干活" → judge intent:
  - if the user wants to start working there now (a fresh conversation in that directory) → create a new session with `cwd` = that directory.
  - if the user only wants to change the default directory for future sessions → call set-cwd.
  - when ambiguous, prefer creating a new session (the more common intent for "切换到").
- Directory names may be fuzzy or relative; resolve them to an absolute local path (using your file tools) before calling either endpoint.
- `open_id` must always be passed as exactly {{open_id}}; do not invent it.
- The capability grant is bound to this session. Never reuse a grant with another session ID.
