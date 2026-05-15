# Receiving & Sending Files (WeChat)

## Receive Files

Files sent to the bot are **automatically downloaded** to `~/.chatccc/images/downloads/` with the `wx_` filename prefix.

The message text you receive will include the downloaded path in the format:
```
[文件] C:\Users\<用户名>\.chatccc\images\downloads\wx_<key>_<filename>
```

You can read the file at that path to understand what the user sent.

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
await wire.sendMediaFile(chatId, contextToken, fileBuffer, "filename.pdf", "caption");
```

### Rules

- Save or choose a local file first.
- Use an absolute local path.
- Supported formats: .pdf, .doc, .docx, .xls, .xlsx, .csv, .ppt, .pptx, .txt, .zip, .tar, .gz, .rar, .7z, .mp3, .wav, .ogg, .aac, .m4a.
- Max file size: 100MB.
- Only send a file when the user asked for one or when it materially helps the answer.
- **Claw 限制**: 文件发送也计入微信 claw 连发计数，连续 10 条未回复会截断。