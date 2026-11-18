/** Reserved whole-value marker: never expose a code-shaped historical excerpt. */
export function omittedToolArgument(characters: number): string {
  return `[[DEEPCCC_OMITTED_TOOL_ARGUMENT chars=${characters}; read the original saved file before reuse]]`;
}

export function isOmittedToolArgument(value: unknown): boolean {
  // A model may damage the hash, delimiters or surrounding whitespace. Such a
  // reserved metadata value is still unavailable input, never executable code.
  // Literal marker text inside an ordinary script remains ordinary source.
  return typeof value === "string" && /^\s*\[\[DEEPCCC_OMITTED_TOOL_ARGUMENT(?=\s|\]|$)/.test(value);
}

/** The callback saves an original string and returns a marker only after storage succeeds. */
export type ToolArgumentPreserver = (text: string) => string | undefined;

export function artifactToolArgument(filename: string): string {
  if (!/^[a-f0-9]{64}\.txt$/.test(filename)) throw new Error("Invalid tool argument artifact name");
  return `[[DEEPCCC_OMITTED_TOOL_ARGUMENT artifact=${filename}]]`;
}

const ARTIFACT_MARKER_CHARS = artifactToolArgument("0".repeat(64)+".txt").length;

export function compactJsonValue(value: unknown, maximum: number, output = false,
  preserveArgument?: ToolArgumentPreserver): unknown {
  const raw = JSON.stringify(value);
  if (raw === undefined) return value;
  if (raw.length <= maximum) return value;
  const box = { value: JSON.parse(raw) as unknown };
  const leaves: Array<{ object: Record<string, unknown>; key: string }> = [];
  const visit = (object: Record<string, unknown>, key: string): void => {
    const item = object[key];
    if (typeof item === "string") leaves.push({ object, key });
    else if (item && typeof item === "object") {
      for (const child of Object.keys(item)) visit(item as Record<string, unknown>, child);
    }
  };
  visit(box, "value");
  leaves.sort((a, b) => (b.object[b.key] as string).length - (a.object[a.key] as string).length);
  for (const leaf of leaves) {
    const text = leaf.object[leaf.key] as string;
    if (!output && isOmittedToolArgument(text)) continue;
    const artifact = !output && preserveArgument && text.length > ARTIFACT_MARKER_CHARS
      ? preserveArgument(text) : undefined;
    const replacement = output
      ? `[[DEEPCCC_OMITTED_TOOL_OUTPUT chars=${text.length}; inspect the saved evidence]]`
      : artifact ?? omittedToolArgument(text.length);
    if (replacement.length >= text.length) continue;
    if (output) {
      const otherChars = JSON.stringify(box.value).length - JSON.stringify(text).length;
      let available = Math.max(0, maximum - otherChars - 2 - replacement.length);
      for (let attempt = 0; attempt < 8; attempt++) {
        const head = Math.ceil(available / 2);
        const tail = Math.floor(available / 2);
        leaf.object[leaf.key] = text.slice(0, head) + replacement + (tail ? text.slice(-tail) : "");
        const excess = JSON.stringify(box.value).length - maximum;
        if (excess <= 0 || available === 0) break;
        available = Math.max(0, available - excess);
      }
    } else {
      leaf.object[leaf.key] = replacement;
    }
    if (JSON.stringify(box.value).length <= maximum) return box.value;
  }
  if (!output && preserveArgument) {
    // If a complete argument object does not fit, retain a short reference to
    // its bounded projection. Nested artifact markers still recover original strings.
    const marker = preserveArgument(JSON.stringify(box.value, null, 2));
    const filename = marker?.match(/^\[\[DEEPCCC_OMITTED_TOOL_ARGUMENT artifact=([a-f0-9]{64}\.txt)\]\]$/)?.[1];
    if (filename) {
      const reference = { __deepccc_input_artifact: filename };
      if (JSON.stringify(reference).length <= maximum) return reference;
    }
  }
  // A large collection of small fields may not fit. Keep valid JSON and state
  // that the historical arguments are unavailable rather than inventing a raw call.
  if (output && value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const status: Record<string, unknown> = { __deepccc_output_omitted: true };
    for (const key of ["exitCode", "timedOut", "running", "taskId", "signal", "backgrounded"]) {
      const item = record[key];
      if (item !== null && !["string", "number", "boolean"].includes(typeof item)) continue;
      const candidate = { ...status, [key]: item };
      if (JSON.stringify(candidate).length <= maximum) Object.assign(status, candidate);
    }
    if (Object.keys(status).length > 1 && JSON.stringify(status).length <= maximum) return status;
  }
  const fallback = { __deepccc_payload_unavailable: true, originalChars: raw.length };
  return JSON.stringify(fallback).length <= maximum ? fallback : {};
}

/** Undefined means plain text, so callers can retain their text-output policy. */
export function compactJsonText(text: string, maximum: number, output = false,
  preserveArgument?: ToolArgumentPreserver): string | undefined {
  if (maximum < 2) return "";
  if (text.length <= maximum) return text;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  return JSON.stringify(compactJsonValue(value, maximum, output, preserveArgument));
}
