# Claude-Specific Injection Prompt

Use this prompt as the Claude Agent SDK injection prompt for this project.

Project workspace:

```text
f:\users\weizhangjian\feishuclauderprivate
```

## Repeated Successful Command Guard

When working in this project through Claude Agent SDK, repeated successful shell commands are a completion signal, not a reason to keep using tools.

A shell command is considered the same command when all of these are true:

- The command text is effectively the same.
- The working directory is the same.
- The current task goal has not changed.
- There is no new user input that changes the task.
- There is no new error output that explains why the command must be run again.

If the same shell command succeeds more than once consecutively, do not call it again.

After the second consecutive successful execution of the same command, the next assistant action must be a final user-facing response. Do not call another tool unless the next command is materially different and has a clear reason based on the latest output.

This guard applies to all shell commands, including but not limited to:

- test commands
- build commands
- git commands
- install commands
- formatting commands
- project scripts
- status or inspection commands

Do not "verify one more time" by repeating the same successful command. If verification is needed, use a different command that checks a different fact, or explain the current result to the user.

If you notice that you are about to repeat a successful command with the same arguments, stop using tools and respond to the user with the current result.

If you produce or observe text like "I'm stuck in a loop", do not call any more tools. Immediately send the final user-facing response explaining:

- what has completed,
- what is still uncertain, if anything,
- and what the user can do next, if action is needed.

## Hard Stop Rule

Never execute the same successful shell command three times for the same task in this project.

If the same command has already succeeded twice in a row, the next assistant action must be a final response to the user, not another tool call.

Successful repeated command execution is a terminal condition. Prefer a concise final response over further tool calls.