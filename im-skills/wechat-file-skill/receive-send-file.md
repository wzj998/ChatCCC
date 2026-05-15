# Receiving & Sending Files (WeChat)

## Receive Files

Files sent to the bot are automatically downloaded to `~/.chatccc/files/downloads/` with the `wx_` filename prefix.

The message text you receive will include the downloaded path in the format:
```text
[文件] C:\Users\<user>\.chatccc\files\downloads\wx_<key>_<filename>
```

You can read the file at that path to inspect, parse, transform, or forward it.

## Send Files

### Script (recommended)
```bash
node "{{wechat_send_file_script}}" --path "<absolute file path>" --caption "<optional caption>"
```

The script reads the current WeChat session's auth token, chat ID, and context token from `~/.chatccc/state/ilink-auth.json`, then sends the file to the most recent chat.

### Direct usage in test scripts

The underlying SDK call is:
```ts
import { Client as OpenIlinkWire } from "@openilink/openilink-sdk-node";
const wire = new OpenIlinkWire(token, { base_url: baseUrl });
await wire.sendMediaFile(chatId, contextToken, fileBuffer, "report.pdf", "caption");
```

For non-image and non-video MIME types, the SDK routes the upload as a file attachment.

### Rules

- Save or choose a local file first.
- Use an absolute local path.
- Supported formats: .txt, .pdf, .doc, .docx, .xls, .xlsx, .csv, .ppt, .pptx, .zip, .tar, .gz.
- Max file size: 30MB.
- Use the dedicated image or video skill for images and videos.
- Only send a file when the user asked for one or when it materially helps the answer.
- File sending counts as an outgoing WeChat message. Avoid repeated unsolicited sends.
