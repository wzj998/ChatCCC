/** Narrow syntax recovery: never edit quoted data or synthesize missing values. */
export function parseJsonResponse(text: string): {value: unknown; repaired: boolean} {
  try { return {value: JSON.parse(text), repaired: false}; } catch { /* one local recovery */ }
  let quoted = false, escaped = false, previous = '', cleaned = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    let keep = true;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ',' && previous && !'{[,:'.includes(previous)) {
      let next = i + 1;
      while (next < text.length && ' \t\r\n'.includes(text[next])) next++;
      keep = !(next < text.length && '}]'.includes(text[next]));
    }
    if (keep) cleaned += char;
    if (!' \t\r\n'.includes(char)) previous = char;
  }
  return {value: JSON.parse(cleaned), repaired: cleaned !== text};
}
