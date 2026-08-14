import { describe, expect, it } from "vitest";

import { cardActionToCommand, parseCardAction } from "../card-action-parser.ts";
import { buildHelpCard } from "../cards.ts";

/** 从 help 卡片 JSON 中提取全部按钮 value */
function helpCardButtonValues(): string[] {
  const card = JSON.parse(buildHelpCard("hi")) as {
    elements?: { tag?: string; actions?: { value?: string }[] }[];
  };
  const values: string[] = [];
  for (const el of card.elements ?? []) {
    for (const btn of el.actions ?? []) {
      if (typeof btn.value === "string") values.push(btn.value);
    }
  }
  return values;
}

function actionEvent(value: unknown, extra: Record<string, unknown> = {}) {
  return {
    event: {
      action: { value },
      open_chat_id: "oc-test",
      operator: { open_id: "ou-test" },
      ...extra,
    },
  };
}

describe("parseCardAction", () => {
  it("maps the /new ccc help-card button to the /new ccc command", () => {
    const result = parseCardAction(actionEvent(JSON.stringify({ cmd: "new ccc" })));
    expect(result?.text).toBe("/new ccc");
    expect(result?.chatId).toBe("oc-test");
    expect(result?.openId).toBe("ou-test");
  });

  it("every help-card button value resolves to a non-empty command (no silent dead buttons)", () => {
    const values = helpCardButtonValues();
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      const result = parseCardAction(actionEvent(value));
      expect(result, `button value ${value} should resolve`).not.toBeNull();
      expect(result?.text.length).toBeGreaterThan(0);
    }
  });

  it("maps object-form button values (progress card 停止) to commands", () => {
    expect(parseCardAction(actionEvent({ action: "stop" }))?.text).toBe("/stop");
    expect(parseCardAction(actionEvent({ action: "state" }))?.text).toBe("/state");
  });

  it("keeps cd path from object-form values", () => {
    expect(parseCardAction(actionEvent({ action: "cd", path: "D:/repo" }))?.text).toBe("/cd D:/repo");
  });

  it("passes through slash-prefixed dynamic commands such as /model <name>", () => {
    expect(parseCardAction(actionEvent(JSON.stringify({ cmd: "/model gpt-5" })))?.text).toBe("/model gpt-5");
  });

  it("returns null for unknown cmds instead of mapping to an empty command", () => {
    expect(parseCardAction(actionEvent(JSON.stringify({ cmd: "no-such-button" })))).toBeNull();
    expect(parseCardAction(actionEvent(JSON.stringify({ cmd: "ccc" })))).toBeNull();
  });

  it("returns null when the value is missing or unparseable", () => {
    expect(parseCardAction(actionEvent(undefined))).toBeNull();
    expect(parseCardAction(actionEvent("not-json{"))).toBeNull();
  });
});

describe("cardActionToCommand", () => {
  it("covers every tool that /new accepts", () => {
    expect(cardActionToCommand("new")).toBe("/new");
    expect(cardActionToCommand("new claude")).toBe("/new claude");
    expect(cardActionToCommand("new cursor")).toBe("/new cursor");
    expect(cardActionToCommand("new codex")).toBe("/new codex");
    expect(cardActionToCommand("new ccc")).toBe("/new ccc");
    expect(cardActionToCommand("new dsh")).toBe("/new dsh");
  });
});
