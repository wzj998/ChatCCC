import { sanitizeTerminalErrorDetail } from "./terminal-error.ts";

export interface FeishuConnectionCallbacks {
  onReady(): void;
  onReconnected(): void;
  onReconnecting(): void;
  onError(error: Error): void;
}

interface ReceivingClient {
  start(): Promise<void>;
  close(options: { force: boolean }): void;
  getConnectionStatus(): { state: string; lastConnectTime?: number; nextConnectTime?: number; reconnectAttempts?: number };
}

interface Options {
  createClient(callbacks: FeishuConnectionCallbacks): ReceivingClient;
  onConnected(): void | Promise<void>;
  log(event: string, detail?: Record<string, unknown>): void;
  checkIntervalMs?: number;
  stalledAfterMs?: number;
  startupTimeoutMs?: number;
}

/** Owns only the receiving transport. It never resets sessions or replays tasks. */
export function createFeishuConnectionSupervisor(options: Options) {
  const stalledAfterMs = options.stalledAfterMs ?? 90_000;
  let stopped = false;
  let client: ReceivingClient | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let startup: Promise<void> | undefined;
  let resolveStartup: (() => void) | undefined;
  let rejectStartup: ((error: Error) => void) | undefined;
  let unhealthySince: number | undefined;
  let lastState = "idle";
  let connected = false;
  let launching = false;
  let lastAttempt = 0;

  const log = (event: string, detail?: Record<string, unknown>) => {
    try { options.log(event, detail); } catch { /* diagnostics cannot break recovery */ }
  };
  const reportError = (error: unknown) => {
    if (stopped) return;
    connected = false;
    unhealthySince ??= Date.now();
    log("connection error", { reason: sanitizeTerminalErrorDetail(error instanceof Error ? error.message : String(error)) });
  };
  const becameConnected = () => {
    if (stopped) {
      // A handshake already in flight can finish after close(); never resurrect
      // a transport belonging to a stopped setup attempt or shutting-down app.
      try { client?.close({ force: true }); } catch { /* best effort */ }
      return;
    }
    if (connected) return;
    connected = true;
    unhealthySince = undefined;
    lastState = "connected";
    log("connected");
    if (startupTimer) clearTimeout(startupTimer);
    resolveStartup?.();
    resolveStartup = undefined;
    rejectStartup = undefined;
    void Promise.resolve().then(() => stopped ? undefined : options.onConnected()).catch((error) => {
      log("binding recovery failed", { reason: sanitizeTerminalErrorDetail(String(error)) });
    });
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    if (startupTimer) clearTimeout(startupTimer);
    try { client?.close({ force: true }); } catch { /* best effort shutdown */ }
    rejectStartup?.(new Error("飞书长连接在就绪前已停止"));
    resolveStartup = undefined;
    rejectStartup = undefined;
    log("stopped");
  };
  const launch = () => {
    if (stopped || launching || !client) return;
    launching = true;
    lastAttempt = Date.now();
    unhealthySince = lastAttempt;
    void Promise.resolve().then(() => stopped ? undefined : client!.start())
      .catch(reportError).finally(() => { launching = false; });
  };
  const check = () => {
    if (stopped || !client) return;
    try {
      const status = client.getConnectionStatus();
      if (status.state !== lastState) {
        lastState = status.state;
        log("state", { ...status });
      }
      if (status.state === "connected") {
        becameConnected();
        return;
      }
      connected = false;
      unhealthySince ??= Date.now();
      // SDK gets a bounded chance to recover. Silence from users is irrelevant.
      if (launching || Date.now() - unhealthySince < stalledAfterMs
        || Date.now() - lastAttempt < stalledAfterMs) return;
      log("restarting receiving connection", { ...status, disconnectedForMs: Date.now() - unhealthySince });
      client.close({ force: true });
      launch();
    } catch (error) { reportError(error); }
  };
  const start = (): Promise<void> => {
    if (startup) return startup;
    if (stopped) return Promise.reject(new Error("飞书长连接已停止"));
    startup = new Promise<void>((resolve, reject) => { resolveStartup = resolve; rejectStartup = reject; });
    startupTimer = setTimeout(() => {
      rejectStartup?.(new Error("飞书长连接握手超时，尚未收到连接成功确认"));
      rejectStartup = undefined;
      stop();
    }, options.startupTimeoutMs ?? 45_000);
    try {
      client = options.createClient({
        onReady: becameConnected,
        onReconnected: becameConnected,
        onReconnecting() {
          if (stopped) return;
          connected = false;
          unhealthySince ??= Date.now();
          log("reconnecting");
        },
        onError: reportError,
      });
      timer = setInterval(check, options.checkIntervalMs ?? 10_000);
      timer.unref();
      launch();
    } catch (error) {
      rejectStartup?.(error instanceof Error ? error : new Error(String(error)));
      rejectStartup = undefined;
      stop();
    }
    return startup;
  };
  return { start, stop };
}
