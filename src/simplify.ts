import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { PROJECT_ROOT } from "./config.ts";

// ---------------------------------------------------------------------------
// 消息简化规则 —— 数据驱动，在 simplify.json 中配置
// ---------------------------------------------------------------------------

interface ToolRule {
  template: string;
  maxLength: number;
}

interface SimplifyConfig {
  tool_use?: Record<string, ToolRule>;
  tool_result?: Record<string, ToolRule>;
}

let config: SimplifyConfig | null = null;
let loaded = false;

function loadConfig(): SimplifyConfig {
  const filePath = resolvePath(PROJECT_ROOT, "simplify.json");
  if (!existsSync(filePath)) return {};
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.error("[SIMPLIFY] simplify.json 格式错误：应为对象");
      return {};
    }
    return parsed as SimplifyConfig;
  } catch (err) {
    console.error(`[SIMPLIFY] 读取 simplify.json 失败: ${(err as Error).message}`);
    return {};
  }
}

function getConfig(): SimplifyConfig {
  if (!loaded) {
    config = loadConfig();
    loaded = true;
  }
  return config!;
}

/** 热重载 */
export function reloadSimplifyConfig(): void {
  loaded = false;
  config = null;
}

/**
 * 对模板字符串中的 {field} 占位符做替换。
 * fields 为可用字段映射，extra 是额外的上下文（如 tool_use_id 的 id）。
 */
function resolveTemplate(template: string, fields: Record<string, unknown>, extra?: Record<string, string>): string {
  let result = template;
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      result = result.split(`{${k}}`).join(v);
    }
  }
  for (const [k, v] of Object.entries(fields)) {
    const strVal = typeof v === "string" ? v : JSON.stringify(v);
    result = result.split(`{${k}}`).join(strVal);
  }
  return result;
}

/**
 * 简化 tool_use 展示。
 * 返回 null 表示无规则，调用方应回退到默认格式化。
 */
export function simplifyToolUse(name: string, input: unknown): string | null {
  const cfg = getConfig();
  const rules = cfg.tool_use;
  if (!rules) return null;
  const rule = rules[name];
  if (!rule) return null;

  const fields = typeof input === "object" && input !== null
    ? input as Record<string, unknown>
    : {};
  let result = resolveTemplate(rule.template, fields);
  if (result.length > rule.maxLength) {
    result = result.slice(0, rule.maxLength) + "...";
  }
  return result;
}

/**
 * 简化 tool_result 展示。
 * 返回 null 表示无规则，调用方应回退到默认格式化。
 * toolCallInput 为对应的 tool_use 输入（可选），用于在 result 模板中引用输入字段。
 */
export function simplifyToolResult(
  name: string,
  toolUseId: string,
  isError: boolean,
  toolCallInput?: unknown,
): string | null {
  const cfg = getConfig();
  const rules = cfg.tool_result;
  if (!rules) return null;
  const rule = rules[name];
  if (!rule) return null;

  const id = toolUseId.slice(-6);
  const extra = { id };
  const fields = toolCallInput && typeof toolCallInput === "object"
    ? toolCallInput as Record<string, unknown>
    : {};
  let result = resolveTemplate(rule.template, fields, extra);
  if (isError) result = "❌ " + result;
  if (result.length > rule.maxLength) {
    result = result.slice(0, rule.maxLength) + "...";
  }
  return result;
}