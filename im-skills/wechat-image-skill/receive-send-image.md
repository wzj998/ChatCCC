# Receiving & Sending Images (WeChat)

## Receive Images

Images sent to the bot are **automatically downloaded** to `~/.chatccc/images/downloads/` with the `wx_` filename prefix.

The message text you receive will include the downloaded path in the format:
```
[图片] C:\Users\<用户名>\.chatccc\images\downloads\wx_<key>.png
```

You can read the image file at that path to understand what the user sent.

## Send Images

### Script (recommended)
```bash
node "{{wechat_send_image_script}}" --path "<absolute image path>" --caption "<optional caption>"
```

The script reads the current WeChat session's auth token, chat ID, and context token from `~/.chatccc/state/ilink-auth.json`, then sends the image to the most recent chat.

### Direct usage in test scripts

The underlying SDK call is:
```ts
import { Client as OpenIlinkWire } from "@openilink/openilink-sdk-node";
const wire = new OpenIlinkWire(token, { base_url: baseUrl });
await wire.sendMediaFile(chatId, contextToken, imageBuffer, "filename.png", "caption");
```

### Rules

- Save or choose a local image file first.
- Use an absolute local path.
- Supported formats: .png, .jpg, .jpeg, .webp, .gif, .bmp.
- Max image size: 10MB (SDK guideline; larger files upload slower).
- Only send an image when the user asked for one or when it materially helps the answer.
- **Claw 限制**: 图片发送也计入微信 claw 连发计数，连续 10 条未回复会截断。