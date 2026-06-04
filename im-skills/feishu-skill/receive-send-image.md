# Sending & Receiving Images

## Send Images

**Use the node script below. Do NOT use curl or raw HTTP — the script correctly handles errors and exits non-zero on failure.**

### Script

```bash
node "{{send_image_script}}" --url "{{send_image_url}}" --session-id "{{session_id}}" --path "<absolute image path>" --caption "<optional caption>"
```

### Rules

- Use the node script above — never curl or raw HTTP.
- Save or choose a local image file first.
- Use an absolute local path.
- Supported formats: .png, .jpg, .jpeg, .webp, .gif, .bmp.
- Max image size: 10MB.
- Only send an image when the user asked for one or when it materially helps the answer.
- **If the script fails (non-zero exit), read stderr for the error. Do NOT retry with the same path. Either fix the problem (wrong extension, missing file, etc.) or tell the user what the error was. Never retry more than once.**

## Receive Images

Images sent to the bot are automatically downloaded to `~/.chatccc/images/downloads/`. The message contains an `image_key` that maps to the cached file.