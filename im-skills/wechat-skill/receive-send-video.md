# Receiving & Sending Videos (WeChat)

## Receive Videos

Videos sent to the bot are **automatically downloaded** to `~/.chatccc/images/downloads/` with the `wx_` filename prefix.

The message text you receive will include the downloaded path in the format:
```
[视频] C:\Users\<用户名>\.chatccc\images\downloads\wx_<key>.mp4
```

You can read the video file at that path to understand what the user sent.

## Send Videos

### Script (recommended)
```bash
node "{{wechat_send_video_script}}" --path "<absolute video path>" --caption "<optional caption>"
```

The script reads the current WeChat session's auth token, chat ID, and context token from `~/.chatccc/state/ilink-auth.json`, then sends the video to the most recent chat.

### Direct usage in test scripts

The underlying SDK call is:
```ts
import { Client as OpenIlinkWire } from "@openilink/openilink-sdk-node";
const wire = new OpenIlinkWire(token, { base_url: baseUrl });
await wire.sendMediaFile(chatId, contextToken, videoBuffer, "video.mp4", "caption");
```

### Rules

- Save or choose a local video file first.
- Use an absolute local path.
- Supported formats: .mp4, .mov, .avi, .mkv, .webm, .flv.
- Max video size: 100MB.
- Only send a video when the user asked for one or when it materially helps the answer.
- **Claw 限制**: 视频发送也计入微信 claw 连发计数，连续 10 条未回复会截断。