# Sending & Receiving Images

## Send Images

First, query the current send token:
```bash
curl "{{session_grants_url}}?sid={{session_id}}"
```

Then send with the returned url and token:

### Script (recommended)
```bash
node "{{send_image_script}}" --url <url_from_query> --token <token_from_query> --path "<absolute image path>" --caption "<optional caption>"
```

### Direct HTTP
```http
POST <url_from_query>
Authorization: Bearer <token_from_query>
Content-Type: application/json; charset=utf-8

{"path":"<absolute image path>","caption":"<optional caption>"}
```

### Rules

- Save or choose a local image file first.
- Use an absolute local path.
- Supported formats: .png, .jpg, .jpeg, .webp, .gif, .bmp.
- Max image size: 10MB.
- Only send an image when the user asked for one or when it materially helps the answer.

## Receive Images

Images sent to the bot are automatically downloaded to `~/.chatccc/images/downloads/`. The message contains an `image_key` that maps to the cached file.