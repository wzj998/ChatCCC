type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function textContent(value: unknown): string | null {
  if (typeof value === "string") return stringValue(value);
  if (!isObject(value)) return null;
  return stringValue(value.content);
}

function parseButtonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function commandFromValue(value: unknown): string | null {
  const parsed = parseButtonValue(value);
  if (typeof parsed === "string") {
    const trimmed = parsed.trim();
    return trimmed.startsWith("/") ? trimmed : null;
  }
  if (!isObject(parsed)) return null;

  const cmd = stringValue(parsed.cmd);
  if (cmd) return cmd.startsWith("/") ? cmd : `/${cmd}`;

  const action = stringValue(parsed.action);
  if (!action) return null;

  if (action === "cd") {
    const path = stringValue(parsed.path);
    return path ? `/cd ${path}` : "/cd";
  }
  return action.startsWith("/") ? action : `/${action}`;
}

function buttonText(element: JsonObject): string | null {
  const label = textContent(element.text);
  const command = commandFromValue(element.value);
  if (label && command) return `${label}: ${command}`;
  return label ?? command;
}

function elementToText(element: unknown): string[] {
  if (!isObject(element)) return [];
  const tag = stringValue(element.tag);

  if (tag === "div") {
    const content = textContent(element.text);
    return content ? [content] : [];
  }

  if (tag === "markdown") {
    const content = stringValue(element.content);
    return content ? [content] : [];
  }

  if (tag === "button") {
    const content = buttonText(element);
    return content ? [content] : [];
  }

  if (tag === "action" && Array.isArray(element.actions)) {
    return element.actions.flatMap(elementToText);
  }

  return [];
}

function rootElements(card: JsonObject): unknown[] {
  if (Array.isArray(card.elements)) return card.elements;
  if (isObject(card.body) && Array.isArray(card.body.elements)) {
    return card.body.elements;
  }
  return [];
}

export function cardJsonToPlainText(cardJson: string): string | null {
  let card: unknown;
  try {
    card = JSON.parse(cardJson);
  } catch {
    return null;
  }
  if (!isObject(card)) return null;

  const title = isObject(card.header) && isObject(card.header.title)
    ? textContent(card.header.title)
    : null;
  const lines = rootElements(card).flatMap(elementToText);
  const parts = title ? [`# ${title}`, ...lines] : lines;
  const text = parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return text || null;
}
