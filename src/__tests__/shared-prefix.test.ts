import { describe, expect, it } from "vitest";

import {
  ABD_APPEND_PROMPT,
  applySharedPrefix,
} from "../shared-prefix.ts";

describe("applySharedPrefix", () => {
  it("leaves normal messages unchanged", () => {
    expect(applySharedPrefix("帮我分析")).toEqual({
      matched: false,
      text: "帮我分析",
      body: "帮我分析",
    });
  });

  it("removes /abd without requiring a space", () => {
    const result = applySharedPrefix("/abd帮我分析");

    expect(result.matched).toBe(true);
    expect(result.body).toBe("帮我分析");
    expect(result.text).toBe(`帮我分析\n\n---\n${ABD_APPEND_PROMPT}`);
  });

  it("removes whitespace after /abd", () => {
    const result = applySharedPrefix("/abd   帮我分析");

    expect(result.text).toBe(`帮我分析\n\n---\n${ABD_APPEND_PROMPT}`);
  });

  it("keeps the appendix when the user body is empty", () => {
    const result = applySharedPrefix("/abd   ");

    expect(result.text).toBe(`---\n${ABD_APPEND_PROMPT}`);
  });
});
