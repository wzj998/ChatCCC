import { describe, expect, it } from "vitest";

import { cardJsonToPlainText } from "../card-plain-text.ts";
import {
  buildHelpCard,
  buildProgressCard,
  buildStatusCard,
} from "../cards.ts";

describe("cardJsonToPlainText", () => {
  it("converts help cards to readable text with commands", () => {
    const text = cardJsonToPlainText(buildHelpCard("hello"));

    expect(text).toContain("# ChatCCC");
    expect(text).toContain("hello");
    expect(text).toContain("/new");
    expect(text).toContain("/new cursor");
    expect(text).toContain("/new codex");
    expect(text).toContain("/restart");
    expect(text).toContain("/cd");
  });

  it("converts status cards from v1 card format", () => {
    const text = cardJsonToPlainText(buildStatusCard("status body", "green"));

    expect(text).toContain("# 会话状态");
    expect(text).toContain("status body");
  });

  it("converts schema 2.0 progress cards", () => {
    const text = cardJsonToPlainText(buildProgressCard("stream body"));

    expect(text).toContain("# 生成中...");
    expect(text).toContain("stream body");
    expect(text).toContain("/state");
    expect(text).toContain("/stop");
  });

  it("returns null for invalid card json", () => {
    expect(cardJsonToPlainText("{bad json")).toBeNull();
  });
});
