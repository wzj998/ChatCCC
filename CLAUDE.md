## 协作原则（核心）

- **第一性原理思考**：从原始需求和问题出发。若动机或目标不清晰，先讨论；若路径不是最优，直接指出并建议更好的做法
- **重要改动先补测试护栏**：若改动范围大且影响重要，且相关路径没有或不足单元测试覆盖，须先完善对改动前行为的单测，再改实现

## 开发注意点

- **`cmt` / `cmt all` 约定**：`cmt` → 1) 修改注释和文档 2) 运行全部单测 3) `git commit` 只提交当前会话改动。`cmt all` → 上述流程但提交全部改动（含与当前对话无关的）。若无法可靠区分当前会话改动，先问用户
- **`cmp` / `cmp all` 约定**：`cmp` → 执行 `cmt` 后 `git push`。`cmp all` → 执行 `cmt all` 后 `git push`
- **避免 `undefined` 被当成 `false` 使用**：当函数成功时返回 `undefined`（如 `.catch(() => {})` 没有返回值、void 函数等），直接用 `if (result)` 会把成功当成失败。必须用显式比较，例如 `result !== false` 而非 `!result`
- **公有仓库 PR 规则**：ChatCCC 仓库 dev → main 的 PR 必须使用 **merge commit**（Create a merge commit），**禁止 squash**。PR 合并通过 `gh pr merge` 时指定 `--merge`
- **`package.json` 编码红线**：文件开头**禁止 BOM**（部分工具如 tsx 的 `readPackageJson` 会解析失败导致闪退）。编辑后必须用 `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"` 验证无 BOM 且 JSON 合法。写入时用 `utf8` 编码（不含 BOM），`engines.node` 直接用 `">=20"` 不要用 `>` 转义

## 日志位置

- 运行日志、启动黑匣子和 PID/状态等用户数据默认写入用户目录：`~/.chatccc/`
- Windows 常见路径：`C:\Users\<用户名>\.chatccc\logs\`
- 关键文件：
  - `~/.chatccc/logs/index-*.log`：主进程运行日志
  - `~/.chatccc/logs/startup-trace.log`：启动、单实例清理、信号、未捕获异常等同步落盘诊断
- 仓库根目录下的 `logs/` 可能是旧版本或历史运行残留；排查当前 npm/dev 运行问题时，优先看 `~/.chatccc/logs/`
