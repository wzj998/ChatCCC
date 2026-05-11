---
name: send-email
description: Send emails via SMTP. Reads SMTP_SERVER, SMTP_PORT, SMTP_USER, SMTP_PASSWORD from system env vars.
---

## 发送邮件

使用 `scripts/send-email.mjs` 发送邮件。

**用法：**
```bash
node scripts/send-email.mjs --to <recipient> --subject <subject> [--body <html>] [--attach <file1> --attach <file2>]
```

**参数：**
- `--to`: 收件人邮箱
- `--subject`: 邮件主题
- `--body`: 邮件正文（HTML 格式，可选）
- `--attach`: 附件路径（可多个，可选）

**SMTP 配置**从系统环境变量读取：`SMTP_SERVER`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`