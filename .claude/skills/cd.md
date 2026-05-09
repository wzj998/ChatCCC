---
name: cd
description: Change the working directory for the Claude Code session
args: [path]
---

## cd

Change the current working directory by recording the desired path and prompting the user to restart.

### Steps

1. Resolve `$ARGUMENTS` to an absolute path:
   - If relative, resolve against the current working directory
   - Use `Resolve-Path` or equivalent
2. Verify the path exists and is a directory. If not, report the error.
3. Read the MEMORY.md file in the project's `.claude/projects/` memory directory (typically under `~/.claude/projects/`)

Hint: The path is usually `~/.claude/projects/<project-name>/memory/MEMORY.md` where `<project-name>` is derived from the project's absolute path. Check the `memory/` directory under the user's `.claude/projects/` folder.
4. Write or update a reference memory file `working-directory.md` with the new working directory path.
5. Update MEMORY.md if needed to add the pointer.
6. Tell the user:
   - The working directory has been recorded
   - To restart Claude Code in the new directory, exit and run: `claude --cwd "<path>"`