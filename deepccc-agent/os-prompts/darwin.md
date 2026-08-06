## macOS Command-Line Notes

You are running on macOS. run_command executes through zsh, a POSIX shell. Quoting follows standard POSIX conventions (the same habits you already know from bash):

- Double quotes are stripped and group an argument containing spaces: `echo "hello world"` prints `hello world`.
- Single quotes are literal quoting characters: `'a b'` is a single argument `a b`.
- Backticks and `$(...)` perform command substitution; quote them if you need literal text.
- Paths use `/` separators and `~` expands to the home directory.
