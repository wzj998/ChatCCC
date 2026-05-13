# Feishu + WeChat iLink Multi-Platform Architecture

## Goal

ChatCCC should be able to run the existing Feishu bot and a WeChat ClawBot/iLink bot at the same time.

The preferred runtime model is:

```text
one ChatCCC Node.js process
one JavaScript event loop
multiple asynchronous platform adapters
one shared message orchestrator
```

This is not a multi-thread design. Feishu WebSocket, iLink long polling, Web UI HTTP handling, timers, and file I/O are all I/O-bound asynchronous work. They can run concurrently inside the same Node.js process without Worker Threads.

AI tools such as Claude Code, Codex, and Cursor may still be launched as child processes. That is separate from the platform adapter model.

## Why One Process

One process should be the first production design because it keeps the system simpler:

- one config file
- one log tree
- one state directory
- one session registry
- one HTTP/Web UI service
- no cross-process RPC between Feishu and WeChat adapters
- one deployment and one npm command

Separate processes should only be considered if the iLink SDK proves unstable, if platform load becomes very different, or if WeChat needs to be deployed as an independent product surface.

## Current Coupling

The current code is Feishu-centric in a few places:

- `src/index.ts` owns Feishu WebSocket startup, event parsing, command handling, and session dispatch.
- `src/feishu-platform.ts` is an API-level proxy over Feishu-specific operations.
- `src/session.ts` calls Feishu reply/card helpers directly for progress and result rendering.

The WeChat adapter should not try to implement `FeishuPlatform`. Feishu has capabilities that iLink may not have, such as group creation, card messages, card updates, group descriptions, and group avatars.

The cleaner boundary is a higher-level IM platform interface.

## Proposed Interfaces

```ts
export type PlatformName = "feishu" | "ilink";

export interface ChatPlatform {
  name: PlatformName;
  start(onMessage: (message: IncomingMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}

export interface IncomingMessage {
  platform: PlatformName;
  conversationId: string;
  senderId: string;
  messageId: string;
  timestamp: number;
  text: string;
  attachments: IncomingAttachment[];
  raw: unknown;
  reply: MessageReply;
}

export interface IncomingAttachment {
  kind: "image" | "file" | "audio" | "video" | "unknown";
  name?: string;
  localPath?: string;
  raw: unknown;
}

export interface MessageReply {
  text(content: string): Promise<void>;
  status?(payload: StatusPayload): Promise<StatusHandle>;
  updateStatus?(handle: StatusHandle, payload: StatusPayload): Promise<void>;
  image?(path: string, caption?: string): Promise<void>;
  file?(path: string, caption?: string): Promise<void>;
}

export interface StatusPayload {
  title: string;
  body: string;
  state: "thinking" | "streaming" | "done" | "error";
}

export interface StatusHandle {
  platform: PlatformName;
  id: string;
}
```

The orchestrator consumes only `IncomingMessage`. It should not know whether the message came from Feishu or WeChat.

## Runtime Shape

```ts
async function supervise(platform: ChatPlatform): Promise<void> {
  while (!stopping) {
    try {
      await platform.start(handleIncomingMessage);
    } catch (error) {
      logPlatformCrash(platform.name, error);
      await sleep(5000);
    }
  }
}

await Promise.all([
  config.platforms.feishu.enabled ? supervise(feishuPlatform) : Promise.resolve(),
  config.platforms.ilink.enabled ? supervise(ilinkPlatform) : Promise.resolve(),
  startWebUi(),
]);
```

Each adapter owns its own connection loop and recovery. A Feishu failure should not stop iLink. An iLink session expiry should not stop Feishu.

## Conversation Keys

All shared state must use a platform-qualified key:

```ts
const conversationKey = `${message.platform}:${message.conversationId}`;
```

Examples:

```text
feishu:oc_xxx
ilink:wx_user_xxx
```

This key should be used for:

- dedupe state
- `lastMsgTimestamps`
- `chatSessionMap`
- `sessionInfoMap`
- persisted session records
- chat logs
- grant IDs

This avoids collisions between Feishu chat IDs and WeChat user/group IDs.

## Capability Degradation

The platform interface should be capability-based.

Feishu can support:

- text replies
- card replies
- card updates
- image/file replies
- group creation
- group metadata updates
- avatar updates

iLink first version should support:

- text replies
- incoming text messages
- QR login
- token/base URL/sync cursor persistence
- reconnect and session-expired handling

iLink later versions can add:

- image/file send and receive
- voice download/transcription
- group message handling
- throttled progress updates

If `reply.status` or `reply.updateStatus` is unavailable, the orchestrator should degrade to plain text. For example, Feishu can update one progress card while iLink sends a small number of throttled text updates or only the final answer.

## Command Semantics

Feishu currently treats `/new` as "create a new group chat". WeChat cannot reliably mirror that model.

Recommended WeChat behavior:

- one WeChat private chat or group maps to one ChatCCC conversation
- `/new` creates or resets an AI session inside the same WeChat conversation
- `/sessions` returns a text list
- `/restart`, `/cwd`, `/cd`, and tool selection remain text commands
- no group creation in the first iLink version

This keeps user behavior predictable without forcing Feishu-only concepts into WeChat.

## Config Shape

```json
{
  "platforms": {
    "feishu": {
      "enabled": true
    },
    "ilink": {
      "enabled": false,
      "forceQrOnStart": true,
      "reuseTokenOnStart": false
    }
  }
}
```

For backward compatibility, existing `feishu.appId` and `feishu.appSecret` can remain where they are. The `platforms.feishu.enabled` flag only controls whether the adapter is started.

## Web UI Platform Selection

The setup/front-end page should let the user choose which bot platforms are enabled.

Recommended UI controls:

```text
[x] Enable Feishu bot
[ ] Enable WeChat iLink bot
```

The UI should save the result into `~/.chatccc/config.json`:

```json
{
  "platforms": {
    "feishu": {
      "enabled": true
    },
    "ilink": {
      "enabled": true,
      "forceQrOnStart": true,
      "reuseTokenOnStart": false
    }
  }
}
```

The start page or status page should show per-platform status:

```text
Feishu: running / disabled / missing credentials / failed
WeChat iLink: waiting for QR scan / running / session expired / disabled / failed
```

This keeps platform selection explicit. Users should not have to edit JSON by hand for the common case.

## WeChat QR Startup Policy

When `platforms.ilink.enabled` is true, the first production version should always show a fresh QR code on ChatCCC startup.

Policy:

- always request a new iLink QR during startup
- always print both the QR URL/content and a terminal QR code
- do not skip QR login because a previous token exists
- do not add a "reuse previous token" path in the default startup behavior
- overwrite the saved iLink auth snapshot after each successful scan
- continue to persist the sync cursor after login so message polling can resume correctly during the current authenticated run

This matches the demo behavior and avoids confusing "service started but no QR shown" states.

iLink runtime state should not live in `config.json`; it should live under `~/.chatccc/state/`, for example:

```text
~/.chatccc/state/ilink-auth.json
~/.chatccc/state/ilink-sync.json
```

## Implementation Phases

### Phase 1: Extract Orchestrator

Move the platform-independent parts of message handling out of `src/index.ts` into a new orchestrator module.

Target shape:

```ts
export async function handleIncomingMessage(message: IncomingMessage): Promise<void>
```

The first refactor should preserve Feishu behavior exactly.

### Phase 2: Wrap Feishu

Create a `FeishuChatPlatform` that converts Feishu WebSocket events into `IncomingMessage`.

It should adapt existing Feishu functions into `MessageReply`.

### Phase 3: Add iLink Text Adapter

Promote the demo logic into an `IlinkChatPlatform`.

First production scope:

- QR login
- always-visible fresh QR on every startup when iLink is enabled
- no token reuse path in the default startup behavior
- text receive
- text reply
- sync cursor persistence
- reconnect loop
- session-expired logging

### Phase 4: Multi-Platform Startup

Replace single Feishu startup with platform list startup:

```ts
const platforms = createEnabledPlatforms(config);
await Promise.all(platforms.map(supervise));
```

The Web UI should stay in the main process.

### Phase 5: Shared State Migration

Normalize state keys to include platform prefixes.

This should be covered by tests before changing behavior because it affects active sessions, dedupe, and chat logs.

### Phase 6: Media and UX Improvements

Add iLink images/files/voice after the text path is stable.

Avoid trying to clone Feishu card UX. Instead, define a platform-neutral status model and let each platform render it according to its capabilities.

## Testing Plan

Unit tests should cover:

- Feishu event to `IncomingMessage` conversion
- iLink event to `IncomingMessage` conversion
- platform-qualified conversation keys
- dedupe keys across platforms
- fallback when `reply.status` is unavailable
- `/new` behavior for Feishu vs iLink
- iLink sync cursor persistence
- supervisor restart after adapter failure

Integration checks should cover:

- Feishu-only startup
- iLink-only startup
- Feishu + iLink simultaneous startup
- one platform failing without stopping the other

## Recommended First Production Milestone

The first production milestone should be text-only:

```text
Feishu remains behavior-compatible.
iLink can scan, connect, receive text, run the same AI command/session logic, and reply in WeChat text.
```

This is enough to validate the architecture without committing to a full WeChat media/card equivalent too early.
