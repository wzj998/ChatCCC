import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 会话级能力凭据（capability grant）。
 *
 * 内存 Map 是本进程的权威视图；磁盘只用于跨进程重启恢复。
 *
 * 两条必须遵守的约束：
 *  1. 签发后要落盘、校验时先内存后磁盘。否则 ChatCCC 重启会让所有定时发送
 *     （周期报告、后台任务）在重启后立刻收到 403，而工作负载本身仍在运行 ——
 *     故障是静默的。
 *  2. clearAgentCapabilityGrants() 只清内存缓存，**绝不**删盘。它在进程首次启动
 *     的 resetState() 里被调用；若此处删盘，每次重启都会重新随机发码，本修复
 *     直接失效。需要真正作废授权请用 revokeAgentCapabilityGrant()。
 */

const grantsBySession = new Map<string, string>();

/**
 * 与 config.ts 的 USER_DATA_DIR 同源。这里刻意不 import config.ts：该模块在顶层
 * 有副作用（初始化文件日志、加载配置），被测试间接导入会带来多余 I/O 与循环
 * 依赖风险；重复一个路径构造比引入副作用更安全。
 */
const DEFAULT_GRANTS_DIR = join(homedir(), ".chatccc", "state", "agent-grants");

/** 覆盖点（测试/运维）；在每次调用时读取，便于测试导入之后再设置。 */
export function agentGrantDir(): string {
  const override = process.env.CHATCCC_AGENT_GRANT_DIR;
  return override !== undefined && override.trim() !== "" ? override : DEFAULT_GRANTS_DIR;
}

function grantFilePath(sessionId: string): string {
  // sessionId 会进入文件名：只保留安全字符，避免路径穿越。
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(agentGrantDir(), `${safe}.grant`);
}

function readPersistedGrant(sessionId: string): string | undefined {
  try {
    const value = readFileSync(grantFilePath(sessionId), "utf8").trim();
    return value === "" ? undefined : value;
  } catch {
    return undefined; // 不存在 / 不可读都视作“没有持久化授权”
  }
}

function persistGrant(sessionId: string, grant: string): void {
  try {
    mkdirSync(agentGrantDir(), { recursive: true });
    const target = grantFilePath(sessionId);
    const tmp = `${target}.tmp`;
    // Windows 会忽略 mode，实际保护来自用户目录 ACL；POSIX 下为 0600。
    writeFileSync(tmp, `${grant}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, target); // 原子替换，避免读到半写文件
  } catch {
    // 落盘失败不能让签发失败：内存里的授权码在本次进程生命周期内仍然可用。
  }
}

function removePersistedGrant(sessionId: string): void {
  try {
    rmSync(grantFilePath(sessionId), { force: true });
  } catch {
    /* 删除失败不影响内存态 */
  }
}

/** 内存优先；内存没有则从磁盘恢复，避免重启后重新随机发码。 */
function expectedGrant(sessionId: string): string | undefined {
  const inMemory = grantsBySession.get(sessionId);
  if (inMemory !== undefined) return inMemory;
  const persisted = readPersistedGrant(sessionId);
  if (persisted !== undefined) grantsBySession.set(sessionId, persisted);
  return persisted;
}

export function issueAgentCapabilityGrant(sessionId: string): string {
  if (!sessionId) throw new Error("sessionId is required for an agent capability grant");
  const existing = expectedGrant(sessionId);
  if (existing !== undefined) return existing;
  const grant = randomBytes(32).toString("base64url");
  grantsBySession.set(sessionId, grant);
  persistGrant(sessionId, grant);
  return grant;
}

export function validateAgentCapabilityGrant(sessionId: string, candidate: unknown): boolean {
  if (!sessionId || typeof candidate !== "string" || candidate.length === 0) return false;
  const expected = expectedGrant(sessionId);
  if (expected === undefined) return false; // 查不到一律拒绝（fail closed）
  const expectedBytes = Buffer.from(expected, "utf8");
  const candidateBytes = Buffer.from(candidate, "utf8");
  return expectedBytes.length === candidateBytes.length
    && timingSafeEqual(expectedBytes, candidateBytes);
}

/** 真正作废某个会话的授权（内存 + 磁盘）。 */
export function revokeAgentCapabilityGrant(sessionId: string): void {
  grantsBySession.delete(sessionId);
  removePersistedGrant(sessionId);
}

/**
 * 只清内存缓存，**不**删磁盘授权。
 * 调用点：resetState()（进程首次启动）与测试清理。
 * 若在这里同时删盘，则每次重启都会换码 —— 那正是本模块要修掉的故障。
 */
export function clearAgentCapabilityGrants(): void {
  grantsBySession.clear();
}
