import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // fork 池：每个测试文件独立进程，避免 vitest 4.x + Windows 下 runner 初始化竞态
    pool: "forks",
  },
});