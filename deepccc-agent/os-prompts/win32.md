## Windows Command-Line Notes

You are running on Windows. run_command executes through cmd.exe, not bash. cmd quoting differs from bash and breaks common habits:

- Double quotes are NOT stripped: `echo "hello world"` prints `"hello world"` (quotes included), and `"a b" "c"` passes the literal arguments `"a b"` and `"c"` (quotes included) to the program.
- Single quotes are NOT quoting characters in cmd.exe: `'a b'` is parsed as two arguments (`'a` and `b'`).
- Multi-line or quote-heavy inline scripts (python -c "...\n...", ssh host "bash -c '...'") frequently break under cmd quoting; write the script to a temporary file and execute that file instead.
- PowerShell-only syntax (Get-Item, 2>$null, Select-Object) is unavailable; the shell is cmd.exe unless you explicitly invoke powershell.
- To pass an argument containing spaces, use double quotes and expect the quotes to reach the program literally; when the target accepts file input, prefer writing the value to a file.
- Cross-drive `cd` in cmd.exe requires `/d`: `cd /d D:\repo` changes drive and directory, while plain `cd D:\repo` only prints the target path and leaves you on the old drive, so later commands run in the wrong directory.
- npm 11.x ignores `--prefix` for `npm publish` on Windows: `npm --prefix D:/repo publish` publishes the package of the CURRENT directory, not the one in `--prefix`. Always `cd /d` into the package directory first, then run `npm publish` there.
