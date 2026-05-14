# Sending & Downloading Files/Videos

## Send Files or Videos

Videos are sent as regular files (not media), which looks cleaner in Feishu.

### Script (recommended)
```bash
node "{{send_file_script}}" --url "{{send_file_url}}" --session-id "{{session_id}}" --path "<absolute file path>" --caption "<optional caption>"
```

### Direct HTTP
```http
POST {{send_file_url}}
Content-Type: application/json; charset=utf-8

{"session_id":"{{session_id}}","path":"<absolute file path>","caption":"<optional caption>"}
```

### Rules

- Save or choose a local file first.
- Use an absolute local path.
- Max file size: 30MB.
- Supported formats: .mp4 .mov .avi .mkv .webm .flv .mp3 .wav .ogg .aac .m4a .pdf .doc .docx .xls .xlsx .csv .ppt .pptx .txt .zip .tar .gz.
- Only send a file/video when the user asked for one or when it materially helps the answer.

### Video Compression (when file > 30MB)

If the video exceeds 30MB, compress it with ffmpeg before sending.

**Ensure ffmpeg is available** (install if missing):

| OS | Install command |
|----|----------------|
| macOS | `brew install ffmpeg` |
| Linux (Debian/Ubuntu) | `sudo apt install ffmpeg` |
| Linux (RHEL/Fedora) | `sudo dnf install ffmpeg` |
| Windows | `winget install Gyan.FFmpeg` |

**Two-pass compression** (target ~28MB for 30s video, adjust `b:v` for other durations):

```bash
ffmpeg -y -i "<input>" -c:v libx264 -b:v <bitrate>k -pass 1 -f mp4 NUL
ffmpeg -y -i "<input>" -c:v libx264 -b:v <bitrate>k -pass 2 -c:a aac -b:a 128k "<output>"
```

Bitrate formula: `bitrate = 28 × 8 × 1000 ÷ duration_seconds - 128` (target ~28MB, safe under 30MB).
On Windows replace `NUL` with `NUL` (same); on Linux/macOS use `/dev/null`.

If the compressed file still exceeds 30MB, explain to the user that automatic compression wasn't enough and suggest they manually trim or re-encode the source.

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