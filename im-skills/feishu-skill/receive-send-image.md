# Sending & Receiving Images

## Send Images

### Script (recommended)
```bash
node "{{send_image_script}}" --url "{{send_image_url}}" --session-id "{{session_id}}" --path "<absolute image path>" --caption "<optional caption>"
```

### Direct HTTP
```http
POST {{send_image_url}}
Content-Type: application/json; charset=utf-8

{"session_id":"{{session_id}}","path":"<absolute image path>","caption":"<optional caption>"}
```

### Rules

- Save or choose a local image file first.
- Use an absolute local path.
- Supported formats: .png, .jpg, .jpeg, .webp, .gif, .bmp.
- Max image size: 10MB.
- Only send an image when the user asked for one or when it materially helps the answer.

## Receive Images

Images sent to the bot are automatically downloaded to `~/.chatccc/images/downloads/`. The message contains an `image_key` that maps to the cached file.