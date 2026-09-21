import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll } from "vitest";

/**
 * 把能力凭据的落盘目录指向临时目录，避免测试污染真实的
 * `~/.chatccc/state/agent-grants`。
 *
 * 每个测试文件各自拿到一个独立临时目录（vitest 对每个测试文件运行一次 setup），
 * 因此测试之间不会互相看到对方的授权文件。
 */
const dir = mkdtempSync(join(tmpdir(), "chatccc-agent-grants-"));
process.env.CHATCCC_AGENT_GRANT_DIR = dir;

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败不影响测试结论 */
  }
});
