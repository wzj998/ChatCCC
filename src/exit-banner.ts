/**
 * 启动失败或进程立即退出时，在控制台输出统一、醒目的说明（避免用户误以为在后台运行）。
 */

export function printServiceDidNotStart(summary: string): void {
  const bar = "=".repeat(68);
  console.error("\n\n" + bar);
  console.error("  [ 未启动 ] ChatCCC 已退出，当前没有在后台运行。");
  console.error("  [ 提示 ] 修好下列「原因」后请重新执行: chatccc  或  npm run dev");
  console.error(bar);
  console.error(`  原因: ${summary}`);
  console.error(bar + "\n\n");
}

/**
 * 启动成功、进程将常驻时提示用户不要关窗口。
 * 同时打印前端管理面板 URL，方便用户随时打开浏览器查看状态、修改配置（reload 路径
 * 无需重启即可生效，详见 web-ui.ts 的 chooseStartPath 注释）。
 */
export function printServiceRunningHint(
  mode: "sdk" | "local",
  configUrl?: string,
): void {
  const bar = "-".repeat(68);
  const tail = mode === "sdk" ? "飞书长连接与本地中继已就绪。" : "本地中继客户端已就绪。";
  console.log("\n" + bar);
  console.log(`  [ 运行中 ] ${tail}`);
  console.log("  [ 提示 ] 请保持本窗口打开；要停止请按 Ctrl+C。");
  if (configUrl) {
    console.log(`  [ 配置面板 ] ${configUrl} （查看状态 / 修改配置，多数改动无需重启）`);
  }
  console.log(bar + "\n");
}
