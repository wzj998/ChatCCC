#!/usr/bin/env node
import { createRequire, register } from "node:module";
import { pathToFileURL } from "node:url";

const pkgRoot = new URL("../", import.meta.url);
// 勿用 pathToFileURL("./")：会相对于进程 cwd。用 createRequire 从本脚本所在包解析 tsx
const require = createRequire(import.meta.url);
register(pathToFileURL(require.resolve("tsx/esm")), pkgRoot);

await import(new URL("../src/index.ts", import.meta.url));
