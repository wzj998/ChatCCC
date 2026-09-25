## Windows 命令行提示

你运行在 Windows 上。优先绕过 shell，只有需要 shell 运算符时才进入 cmd.exe：

- 单个程序优先用 `run_process`，把可执行文件和每个参数分别放进 `executable` / `args`。它使用 `shell:false`，不会让 cmd.exe 再解释引号、反斜杠、`&`、`%VAR%` 等内容。
- 多行或引号密集的 Python/Node 代码必须用 `run_script`。不要塞进 `python -c` / `node -e`；Windows 下复杂内联代码会被 `run_command` 拒绝，避免命令返回 0 却实际执行了不同代码。
- `run_command` 仅用于 `&&`、管道、重定向等必须由 shell 解析的场景；它通过 cmd.exe 执行，不是 bash，也不是 PowerShell。
- 双引号在 cmd.exe、Node 的 shell 封装和目标程序的 argv 解析之间会经历多层处理；是否保留或剥离取决于具体调用链，不能假设会“原样到达”。单引号在 cmd.exe 中不是可靠的引用字符。
- 使用各命令工具的 `cwd` 参数切换工作目录，不要前置 `cd /d ... &&`。只有手工编写纯 cmd 命令时，跨盘 `cd` 才需要 `/d`。
- PowerShell 专用语法（Get-Item、2>$null、Select-Object）不能直接写进 `run_command`；确需使用时，用 `run_process` 显式执行 `powershell.exe` 并逐项传参。
- npm 11.x 在 Windows 上忽略 `--prefix` 对 `npm publish` 的作用。发布时把工具的 `cwd` 参数设为目标包目录，再执行 `npm publish`。
