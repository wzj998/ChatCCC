import { describe, expect, it } from "vitest";

import { resolveFeishuCardActionChatType } from "../card-action-routing.ts";

describe("resolveFeishuCardActionChatType", () => {
  it("keeps card commands in a persisted private chat on the p2p route", () => {
    expect(resolveFeishuCardActionChatType("private-chat", {
      "private-chat": { chatType: "p2p" },
    })).toBe("p2p");
  });

  it("defaults unknown and group chats to the group route", () => {
    expect(resolveFeishuCardActionChatType("group-chat", {
      "group-chat": { chatType: "group" },
    })).toBe("group");
    expect(resolveFeishuCardActionChatType("unknown-chat", {})).toBe("group");
  });
});
