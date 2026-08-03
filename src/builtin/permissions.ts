import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEEPCCC_HOME } from "./config.js";

// ---------------------------------------------------------------------------
// 权限机制：仅拦截有副作用的工具（run_command / edit_file / create_file /
// delete_file / move_file / apply_patch）。只读工具永不拦截。
//
// 三种信任粒度：
//   - 允许一次（y）：本次操作放行
//   - 永远允许（a）：写入 ~/.deepccc/allow.json，之后按规则自动放行
//   - 本会话允许所有（g）：当前 ChatSession 内全部放行（不落盘）
//   - 拒绝（n）：本次拦截
//
// 判定顺序（PermissionGate.check）：
//   1. mode === "bypass"（--dangerously-bypass-permissions）→ 全部放行
//   2. 本会话已"允许所有" → 放行
//   3. deny 规则命中 → 拒绝
//   4. allow 规则命中 → 放行（覆盖高危判定）
//   5. 仅 run_command 命中内置危险命令库时才进入询问流程；
//      无交互 resolver（非 TTY / JSONL / 程序化调用）时高危自动拒绝。
//      文件编辑等常规操作默认放行（不打断工作流）。
// ---------------------------------------------------------------------------

export type PermissionMode = "ask" | "bypass";
export type PermissionReason = "high-risk" | "rule";
export type PermissionAnswer = "allow" | "allow-always" | "allow-session" | "deny";
export type PermissionDecision = "allow" | "deny";

export interface PermissionRequest {
  /** 工具名：run_command / edit_file / create_file / delete_file / move_file / apply_patch */
  tool: string;
  /** 具体操作：命令全文或文件路径 */
  action: string;
  /** high-risk = 命中内置危险命令库，需要询问；rule = 仅受 allow/deny 规则管控 */
  reason: PermissionReason;
  /** 展示给用户的说明 */
  detail: string;
  /** 额外匹配键（如文件相对路径），allow/deny 规则命中任一即生效 */
  altKeys?: string[];
}

/** ask 模式下高危操作的交互确认回调（由 CLI 注入 readline 实现） */
export type PermissionResolver = (request: PermissionRequest) => Promise<PermissionAnswer>;

export interface AllowRules {
  /** 永远允许的规则，格式 "<tool>:<pattern>" 或 "*:<pattern>"，pattern 中 * 为通配符 */
  allow: string[];
  /** 永远拒绝的规则，格式同上 */
  deny: string[];
}

const RULES_FILE = join(DEEPCCC_HOME, "allow.json");
const EMPTY_RULES: AllowRules = { allow: [], deny: [] };

/**
 * 内置危险命令库（命中即进入询问流程；allow 规则可覆盖）。
 * 覆盖 Windows 与 Unix 常见破坏性操作：强制删除、强制推送、磁盘/分区、
 * 关机重启、设备覆写、数据库 DROP、fork bomb、全局卸载、发布等。
 */
const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  /^\s*rm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\b/i, // rm -rf / rm -fr
  /^\s*rm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\b/i,
  /^\s*rmdir\s+\/s/i, // Windows rmdir /s
  /^\s*(del|erase)\s+\/s/i, // Windows del /s
  /^\s*git\s+(push|fetch|pull)\s+.*(--force|-f\b)/i, // git push --force
  /^\s*git\s+reset\s+--hard/i,
  /^\s*git\s+clean\s+(-[a-z]*f)/i,
  /^\s*format\s+[a-z]:/i,
  /^\s*diskpart\b/i,
  /^\s*(shutdown|reboot)\b/i,
  /^\s*mkfs\b/i,
  /^\s*fdisk\b/i,
  /^\s*dd\s+.*\bof=/i,
  /^\s*sudo\s+(rm|shutdown|mkfs|dd|fdisk|diskpart)/i,
  /^\s*Remove-Item\s+-Recurse/i,
  /^\s*:\(\)\s*\{.*\}\s*;/i, // fork bomb
  /^\s*(drop|truncate)\s+table/i,
  /^\s*npm\s+(publish|unpublish)\b/i,
  /^\s*npm\s+uninstall\s+-g/i,
  /^\s*pip\s+uninstall\b/i,
];

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMAND_PATTERNS.some((re) => re.test(command));
}

// ---------------------------------------------------------------------------
// 规则加载（~/.deepccc/allow.json，热加载）
// ---------------------------------------------------------------------------

let rulesCache: AllowRules | null = null;
let rulesStamp: string | null | undefined;

function rulesFileStamp(): string | null {
  if (!existsSync(RULES_FILE)) return null;
  try {
    const s = statSync(RULES_FILE);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return null;
  }
}

function sanitizeRuleList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function loadRules(): AllowRules {
  if (!existsSync(RULES_FILE)) return EMPTY_RULES;
  try {
    const raw = readFileSync(RULES_FILE, "utf-8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return EMPTY_RULES;
    return {
      allow: sanitizeRuleList((parsed as Record<string, unknown>).allow),
      deny: sanitizeRuleList((parsed as Record<string, unknown>).deny),
    };
  } catch (err) {
    console.error(`[PERMISSIONS] failed to read allow.json: ${(err as Error).message}`);
    return EMPTY_RULES;
  }
}

export function getAllowRules(): AllowRules {
  const stamp = rulesFileStamp();
  if (!rulesCache || stamp !== rulesStamp) {
    rulesCache = loadRules();
    rulesStamp = stamp;
  }
  return rulesCache;
}

export function reloadAllowRules(): void {
  rulesCache = null;
  rulesStamp = undefined;
}

/** 把"永远允许"的规则追加写入 allow.json 并热加载 */
export function appendAllowRule(rule: string): void {
  const rules = getAllowRules();
  if (rules.allow.includes(rule)) return;
  const next: AllowRules = { allow: [...rules.allow, rule], deny: rules.deny };
  try {
    mkdirSync(dirname(RULES_FILE), { recursive: true });
    writeFileSync(RULES_FILE, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
    reloadAllowRules();
  } catch (err) {
    console.error(`[PERMISSIONS] failed to write allow.json: ${(err as Error).message}`);
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 规则匹配。规则格式 "<tool>:<pattern>" 或 "*:<pattern>"；
 * pattern 中的 * 为通配符，其余字符按字面量匹配。
 */
export function matchRule(rule: string, key: string): boolean {
  const ruleColon = rule.indexOf(":");
  if (ruleColon === -1) return false;
  const toolPart = rule.slice(0, ruleColon);
  const pattern = rule.slice(ruleColon + 1);

  const keyColon = key.indexOf(":");
  if (keyColon === -1) return false;
  const keyTool = key.slice(0, keyColon);
  const keyAction = key.slice(keyColon + 1);

  if (toolPart !== "*" && toolPart !== keyTool) return false;
  const re = new RegExp(`^${pattern.split("*").map(escapeRegex).join(".*")}$`);
  return re.test(keyAction);
}

// ---------------------------------------------------------------------------
// PermissionGate
// ---------------------------------------------------------------------------

export class PermissionGate {
  private readonly mode: PermissionMode;
  private readonly resolver?: PermissionResolver;
  private sessionAllowAll = false;

  constructor(mode: PermissionMode = "ask", resolver?: PermissionResolver) {
    this.mode = mode;
    this.resolver = resolver;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  async check(request: PermissionRequest): Promise<PermissionDecision> {
    if (this.mode === "bypass" || this.sessionAllowAll) return "allow";

    const key = `${request.tool}:${request.action}`;
    const keys = [key, ...(request.altKeys ?? []).map((k) => `${request.tool}:${k}`)];
    const rules = getAllowRules();
    if (rules.deny.some((r) => keys.some((k) => matchRule(r, k)))) return "deny";
    if (rules.allow.some((r) => keys.some((k) => matchRule(r, k)))) return "allow";

    // 只有命中内置危险命令库的 run_command 才询问；文件编辑等常规操作默认放行
    if (request.reason !== "high-risk") return "allow";

    // 高危且无交互能力（非 TTY / JSONL / 程序化调用）→ 安全默认拒绝
    if (!this.resolver) return "deny";

    const answer = await this.resolver(request);
    switch (answer) {
      case "allow":
        return "allow";
      case "allow-session":
        this.sessionAllowAll = true;
        return "allow";
      case "allow-always":
        appendAllowRule(key);
        return "allow";
      case "deny":
      default:
        return "deny";
    }
  }
}
