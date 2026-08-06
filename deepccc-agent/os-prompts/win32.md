## Windows 命令行提示

你运行在 Windows 上。run_command 通过 cmd.exe 执行，而不是 bash。cmd 的引号规则与 bash 不同，容易踩坑：

- 双引号不会被剥离：`echo "hello world"` 会原样打印 `"hello world"`（含引号），`"a b" "c"` 会把带引号的字面量 `"a b"` 和 `"c"` 传给程序。
- 单引号在 cmd.exe 中不是引用字符：`'a b'` 会被解析成两个参数（`'a` 和 `b'`）。
- 多行或引号密集的内联脚本（python -c "...\n...", ssh host "bash -c '...'"）在 cmd 引号规则下经常失败；把脚本写入临时文件再执行该文件。
- PowerShell 专用语法（Get-Item、2>$null、Select-Object）不可用；除非显式调用 powershell，否则 shell 是 cmd.exe。
- 传含空格参数时用双引号，并预期引号会原样到达程序；当目标接受文件输入时，优先把值写入文件。
- cmd.exe 跨盘 `cd` 需要 `/d`：`cd /d D:\repo` 才真正切换盘符和目录；裸 `cd D:\repo` 只打印目标路径、停留在原盘，后续命令会在错误的目录执行。
- npm 11.x 在 Windows 上忽略 `--prefix` 对 `npm publish` 的作用：`npm --prefix D:/repo publish` 发布的是**当前目录**的包，而不是 `--prefix` 指向的目录。务必先 `cd /d` 进入包目录，再执行 `npm publish`。
