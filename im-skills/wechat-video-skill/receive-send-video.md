# Receiving & Sending Videos (WeChat)

## Receive Videos

Videos sent to the bot are automatically downloaded to `~/.chatccc/videos/downloads/` with the `wx_` filename prefix.

The message text you receive will include the downloaded path in the format:
```text
[视频] C:\Users\<user>\.chatccc\videos\downloads\wx_<key>.mp4
```

You can read the video file at that path to inspect, transcode, trim, or forward it.

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
await wire.sendMediaFile(chatId, contextToken, videoBuffer, "filename.mp4", "caption");
```

The SDK detects video MIME types from the file name and routes `.mp4`, `.mov`, `.avi`, `.mkv`, `.webm`, and `.flv` as videos.

### Rules

- Save or choose a local video file first.
- Use an absolute local path.
- Supported formats: .mp4, .mov, .avi, .mkv, .webm, .flv.
- Max video size: 30MB.
- Only send a video when the user asked for one or when it materially helps the answer.
- Video sending counts as an outgoing WeChat message. Avoid repeated unsolicited sends.
