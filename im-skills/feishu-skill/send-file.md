## Send Files or Videos

Videos are sent as regular files (not media), which looks cleaner in Feishu.

### Script (recommended)

```bash
node "{{send_file_script}}" --url "{{send_file_url}}" --token "{{send_file_token}}" --path "<absolute file path>" --caption "<optional caption>"
```

### Direct HTTP

```http
POST {{send_file_url}}
Authorization: Bearer {{send_file_token}}
Content-Type: application/json; charset=utf-8

{"path":"<absolute file path>","caption":"<optional caption>"}
```

### Rules

- Save or choose a local file first.
- Use an absolute local path.
- Max file size: 100MB.
- Supported formats: .mp4 .mov .avi .mkv .webm .flv .mp3 .wav .ogg .aac .m4a .pdf .doc .docx .xls .xlsx .csv .ppt .pptx .txt .zip .tar .gz.
- Only send a file/video when the user asked for one or when it materially helps the answer.

## Download Files or Videos

When the user sends a file or video to the bot, the message contains `message_id` and `file_key`. Download it with:

```bash
node "{{download_video_script}}" --message-id <message_id> --file-key <file_key> --name <file_name>
```

If only `chat_id` and `file_key` are available:

```bash
node "{{download_video_script}}" --chat-id <chat_id> --file-key <file_key> --name <file_name>
```

Downloads are saved under `~/.chatccc/videos/downloads/`.