import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { USER_DATA_DIR } from "./config.ts";

// ---------------------------------------------------------------------------
// 隐私替换规则
// ---------------------------------------------------------------------------

interface PrivacyRules {
  [key: string]: string;
}

let rules: PrivacyRules | null = null;
let loaded = false;

function loadRules(): PrivacyRules {
  const filePath = join(USER_DATA_DIR, "privacy.json");
  if (!existsSync(filePath)) {
    return {};
  }
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.error(`[PRIVACY] privacy.json 格式错误：应为对象`);
      return {};
    }
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v !== "string") {
        console.error(`[PRIVACY] privacy.json 值必须为字符串，跳过 "${k}"`);
        delete (parsed as Record<string, unknown>)[k];
      }
    }
    return parsed as PrivacyRules;
  } catch (err) {
    console.error(`[PRIVACY] 读取 privacy.json 失败: ${(err as Error).message}`);
    return {};
  }
}

export function getPrivacyRules(): PrivacyRules {
  if (!loaded) {
    rules = loadRules();
    loaded = true;
  }
  return rules!;
}

/** 重新加载规则（热更新用） */
export function reloadPrivacyRules(): void {
  loaded = false;
  rules = null;
}

/**
 * 对文本应用隐私替换规则。
 * 若无规则或文本为空，直接返回原文。
 */
export function applyPrivacy(text: string): string {
  const r = getPrivacyRules();
  if (Object.keys(r).length === 0 || !text) return text;
  let result = text;
  for (const [from, to] of Object.entries(r)) {
    // 用 split+join 替代 replaceAll，避免正则特殊字符问题
    result = result.split(from).join(to);
  }
  return result;
}