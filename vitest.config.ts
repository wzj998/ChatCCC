import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxConcurrency: 4,
    // 只跑 chatccc 根测试；deepccc-agent 子目录的测试由子目录 vitest.config.ts 独立管理
    include: ["src/**/*.test.ts"],
  },
});
