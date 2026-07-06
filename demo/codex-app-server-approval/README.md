# Codex App Server Approval Demo

This manual demo starts a real `codex app-server`, creates an isolated workspace,
asks a real Codex model to run a command that should require approval, responds
to the approval request with the selected decision, and records every JSON-RPC
frame.

It is intentionally not part of `npm test`: it requires a logged-in Codex CLI,
network access, and model quota.

## Run

```bash
npm run demo:codex-app-server-approval
```

The default decision is `accept`. The default sandbox is `danger-full-access`
because this demo needs to prove the approved command really runs, and Windows
sandbox setup may fail on machines that have not granted the required local
logon rights. Keep the demo workspace isolated.

To exercise another decision:

```bash
npm run demo:codex-app-server-approval -- --decision decline
npm run demo:codex-app-server-approval -- --decision cancel
npm run demo:codex-app-server-approval -- --decision acceptForSession
```

To run all decision branches sequentially:

```bash
npm run demo:codex-app-server-approval -- --decision matrix
```

`matrix` runs the real Codex model once per decision and can consume more time
and quota.

## Useful Options

```bash
npm run demo:codex-app-server-approval -- --timeout-ms 240000
npm run demo:codex-app-server-approval -- --model gpt-5.4
npm run demo:codex-app-server-approval -- --sandbox read-only
npm run demo:codex-app-server-approval -- --sandbox workspace-write
npm run demo:codex-app-server-approval -- --approval-policy untrusted
```

## Output

Each run creates a folder under:

```text
demo/codex-app-server-approval/runs/
```

The important files are:

- `workspace/`: the cwd given to Codex.
- `jsonrpc.jsonl`: every JSON-RPC frame sent to or received from app-server.
- `summary.json`: decision, approval requests, terminal turn status, and file result.
- `server.stderr.log`: app-server stderr.

The demo always attempts to stop the app-server process tree in `finally`.
