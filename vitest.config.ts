import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxConcurrency: 4,
    // 能力凭据测试的落盘目录改到临时目录，避免污染 ~/.chatccc
    setupFiles: ["src/__tests__/setup-agent-grant-dir.ts"],
    // 只跑 chatccc 根测试；deepccc-agent 子目录的测试由子目录 vitest.config.ts 独立管理
    include: ["src/**/*.test.ts"],
  },
});
