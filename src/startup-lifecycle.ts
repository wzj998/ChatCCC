import { spawn, type ChildProcess } from "node:child_process";

/**
 * ChatCCC 自己拉起替代进程时使用的内部标记。
 *
 * 不能用“是否已有配置”判断是否打开控制台：首次配置和日常直接启动都应该
 * 打开，而 `/restart`、`/update` 和 Web UI 重启都不应该打扰用户。环境变量
 * 会自然穿过 cmd/bash/npx 这几层启动器，因此也适用于 Windows 与 Linux。
 */
export const INTERNAL_RESTART_ENV_VAR = "CHATCCC_INTERNAL_RESTART";

type Environment = Record<string, string | undefined>;

export function createInternalRestartEnv(
  inherited: Environment = process.env,
): NodeJS.ProcessEnv {
  return {
    ...inherited,
    [INTERNAL_RESTART_ENV_VAR]: "1",
  };
}

/** 用户直接启动时打开；ChatCCC 内部重启产生的替代进程不打开。 */
interface AutoOpenWebUiOptions {
  env?: Environment;
  openOnStart?: boolean;
}

export function shouldAutoOpenWebUi(options: AutoOpenWebUiOptions = {}): boolean {
  const env = options.env ?? process.env;
  return options.openOnStart !== false && env[INTERNAL_RESTART_ENV_VAR] !== "1";
}

/** Web UI 始终使用 localhost，并跟随实际配置端口。 */
export function buildWebUiUrl(port: number): string {
  return `http://localhost:${port}/`;
}

interface OpenBrowserDeps {
  platform?: NodeJS.Platform;
  env?: Environment;
  spawnImpl?: typeof spawn;
  onError?: (message: string) => void;
  onInfo?: (message: string) => void;
}

/**
 * 调用操作系统默认浏览器打开 Web UI，与 Chrome CDP 守护功能完全独立。
 * 返回值仅表示打开请求是否成功发起；浏览器是否复用标签页由系统浏览器决定。
 */
export function openWebUiInDefaultBrowser(
  port: number,
  deps: OpenBrowserDeps = {},
): boolean {
  const url = buildWebUiUrl(port);
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const spawnImpl = deps.spawnImpl ?? spawn;
  const onError = deps.onError ?? ((message: string) => console.error(message));
  const onInfo = deps.onInfo ?? ((message: string) => console.log(message));

  // Linux 服务器通常没有图形会话。此时调用 xdg-open 只会制造噪音；
  // 直接给出可复制的 SSH 隧道命令，让用户从自己的电脑访问本地 Web UI。
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    onInfo(
      `[WEB-UI] 未检测到 Linux 图形桌面，跳过自动打开浏览器。` +
      `可在本机执行 ssh -L ${port}:127.0.0.1:${port} <user>@<server>，` +
      `然后访问 ${url}`,
    );
    return false;
  }

  try {
    let child: ChildProcess;
    if (platform === "win32") {
      // `start` 会把第一个带引号的参数当窗口标题，空字符串是必要占位符。
      child = spawnImpl("cmd.exe", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
    } else if (platform === "darwin") {
      child = spawnImpl("open", [url], { detached: true, stdio: "ignore" });
    } else {
      child = spawnImpl("xdg-open", [url], { detached: true, stdio: "ignore" });
    }
    child.on("error", (err) => {
      onError(`[WEB-UI] 自动打开浏览器失败: ${err.message}`);
    });
    child.unref();
    return true;
  } catch (err) {
    onError(`[WEB-UI] 自动打开浏览器失败: ${(err as Error).message}`);
    return false;
  }
}
