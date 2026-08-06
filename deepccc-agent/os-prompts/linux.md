## Linux 命令行提示

你运行在 Linux 上。run_command 通过 POSIX shell（bash/sh）执行。引语遵循标准 POSIX 约定（与你在 bash 中已有的习惯相同）：

- 双引号会被剥离并用于组合含空格参数：`echo "hello world"` 打印 `hello world`。
- 单引号是字面量引用字符：`'a b'` 是单个参数 `a b`。
- 反引号和 `$(...)` 执行命令替换；需要字面文本时请加引号。
- 路径使用 `/` 分隔符，`~` 展开为主目录。
