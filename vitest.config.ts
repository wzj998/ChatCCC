import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxConcurrency: 4,
    pool: "forks",
  },
});