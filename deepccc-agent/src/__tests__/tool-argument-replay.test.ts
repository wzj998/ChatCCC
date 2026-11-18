import { describe, expect, it } from "vitest";
import { compactJsonText, compactJsonValue, omittedToolArgument, isOmittedToolArgument } from "../tool-argument-replay.js";

describe("structured historical payloads", () => {
  it("preserves escaped nested fields as valid JSON and leaves input intact", () => {
    const input = { language: "python", nested: { path: "saved.py", code: '\\"\n'.repeat(30_000) } };
    const before = JSON.stringify(input);
    const result = compactJsonValue(input, 600) as typeof input;
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(600);
    expect(result.nested.path).toBe("saved.py");
    expect(isOmittedToolArgument(result.nested.code)).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("keeps a minimal execution status when many large fields cannot fit", () => {
    const input = { stdout: "x".repeat(50_000), stderr: "e".repeat(50_000), command: "c".repeat(50_000), exitCode: 7, timedOut: false };
    const output = JSON.parse(compactJsonText(JSON.stringify(input), 100, true)!);
    expect(output.exitCode).toBe(7);
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(100);
  });

  it("handles undefined and a zero budget without creating partial JSON", () => {
    expect(compactJsonValue(undefined, 100)).toBeUndefined();
    expect(compactJsonText('{"code":"example"}', 0)).toBe("");
    expect(JSON.parse(compactJsonText('{"code":"example"}', 2)!)).toEqual({});
  });

  it("recognizes only reserved whole-value placeholders", () => {
    const marker = omittedToolArgument(50000);
    expect(isOmittedToolArgument(marker)).toBe(true);
    expect(isOmittedToolArgument(`console.log(${JSON.stringify(marker)});`)).toBe(false);
    expect(isOmittedToolArgument("ordinary omitted wording")).toBe(false);
  });

  it("keeps damaged and whitespace-wrapped reserved markers unavailable without guessing an artifact", () => {
    for(const marker of [
      `[[DEEPCCC_OMITTED_TOOL_ARGUMENT artifact=${"a".repeat(63)}.txt]]`,
      ` \n${omittedToolArgument(40)}\n`,
      "[[DEEPCCC_OMITTED_TOOL_ARGUMENT artifact=broken",
    ])expect(isOmittedToolArgument(marker)).toBe(true);
    expect(isOmittedToolArgument('console.log("[[DEEPCCC_OMITTED_TOOL_ARGUMENT artifact=broken]]");')).toBe(false);
    expect(isOmittedToolArgument("[[DEEPCCC_OMITTED_TOOL_ARGUMENTS ordinary identifier]]")).toBe(false);
  });
});
