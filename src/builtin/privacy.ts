import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEEPCCC_HOME } from "./config.js";

interface PrivacyRules {
  [key: string]: string;
}

interface PrivacyConfig {
  enabled: boolean;
  rules: PrivacyRules;
}

let config: PrivacyConfig | null = null;
let loadedStamp: string | null | undefined;

function privacyFilePath(): string {
  return join(DEEPCCC_HOME, "privacy.json");
}

function privacyFileStamp(): string | null {
  const filePath = privacyFilePath();
  if (!existsSync(filePath)) return null;
  try {
    const s = statSync(filePath);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return null;
  }
}

function sanitizeRules(raw: Record<string, unknown>): PrivacyRules {
  const result: PrivacyRules = {};
  for (const [from, to] of Object.entries(raw)) {
    if (!from) {
      console.error("[PRIVACY] privacy.json rule key cannot be empty, skipped");
      continue;
    }
    if (typeof to !== "string") {
      console.error(`[PRIVACY] privacy.json value must be a string, skipped "${from}"`);
      continue;
    }
    result[from] = to;
  }
  return result;
}

function normalizeConfig(parsed: Record<string, unknown>): PrivacyConfig {
  const hasNewSchema =
    Object.prototype.hasOwnProperty.call(parsed, "enabled") ||
    Object.prototype.hasOwnProperty.call(parsed, "rules");

  if (!hasNewSchema) {
    return { enabled: true, rules: sanitizeRules(parsed) };
  }

  const enabledRaw = parsed.enabled;
  const enabled = enabledRaw === undefined ? true : enabledRaw !== false;
  if (enabledRaw !== undefined && typeof enabledRaw !== "boolean") {
    console.error("[PRIVACY] privacy.json enabled must be a boolean, using true");
  }

  const rulesRaw = parsed.rules;
  if (rulesRaw === undefined) return { enabled, rules: {} };
  if (typeof rulesRaw !== "object" || rulesRaw === null || Array.isArray(rulesRaw)) {
    console.error("[PRIVACY] privacy.json rules must be an object");
    return { enabled, rules: {} };
  }
  return { enabled, rules: sanitizeRules(rulesRaw as Record<string, unknown>) };
}

function loadConfig(): PrivacyConfig {
  const filePath = privacyFilePath();
  if (!existsSync(filePath)) {
    return { enabled: true, rules: {} };
  }
  try {
    const raw = readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.error("[PRIVACY] privacy.json must be an object");
      return { enabled: true, rules: {} };
    }
    return normalizeConfig(parsed as Record<string, unknown>);
  } catch (err) {
    console.error(`[PRIVACY] failed to read privacy.json: ${(err as Error).message}`);
    return { enabled: true, rules: {} };
  }
}

export function getPrivacyConfig(): PrivacyConfig {
  const stamp = privacyFileStamp();
  if (!config || stamp !== loadedStamp) {
    config = loadConfig();
    loadedStamp = stamp;
  }
  return config;
}

export function getPrivacyRules(): PrivacyRules {
  return getPrivacyConfig().rules;
}

export function reloadPrivacyRules(): void {
  config = null;
  loadedStamp = undefined;
}

/**
 * 把文本中的隐私规则字面量替换为掩码值（split+join，规则键保持字面量）。
 * 仅作用于展示层：调用方应保持内部数据（如持久化上下文）为原文。
 */
export function applyPrivacy(text: string): string {
  const { enabled, rules } = getPrivacyConfig();
  if (!enabled || Object.keys(rules).length === 0 || !text) return text;

  let result = text;
  for (const [from, to] of Object.entries(rules)) {
    result = result.split(from).join(to);
  }
  return result;
}

/**
 * 递归替换结构化数据（工具调用参数/结果）中的字符串字段。
 * 数组逐项、对象逐值、字符串走 applyPrivacy，其余类型原样返回。
 */
export function applyPrivacyToJson(value: unknown): unknown {
  const { enabled, rules } = getPrivacyConfig();
  if (!enabled || Object.keys(rules).length === 0) return value;
  if (typeof value === "string") return applyPrivacy(value);
  if (Array.isArray(value)) return value.map((item) => applyPrivacyToJson(item));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = applyPrivacyToJson(item);
    }
    return out;
  }
  return value;
}
