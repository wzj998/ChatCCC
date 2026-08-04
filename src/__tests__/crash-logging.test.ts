import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";

import {
  buildCrashLoggingHandlers,
  installCrashLogging,
  installEpipeGuard,
  setupFileLogging,
} from "../shared.ts";

describe("buildCrashLoggingHandlers", () => {
  it("uncaughtException: 写诊断、刷新日志、调用 onFatal", () => {
    const tracer = vi.fn();
    const flush = vi.fn();
    const onFatal = vi.fn();
    const handlers = buildCrashLoggingHandlers({ tracer, flush, onFatal });

    const err = new Error("boom");
    handlers.uncaughtException(err);

    expect(tracer).toHaveBeenCalledWith(
      "FATAL uncaughtException",
      expect.objectContaining({
        message: "boom",
        stack: expect.stringContaining("Error: boom"),
      })
    );
    expect(flush).toHaveBeenCalledTimes(1);
    expect(onFatal).toHaveBeenCalledWith("uncaughtException", err);
  });

  it("unhandledRejection: 字符串 reason 也能转成 Error", () => {
    const tracer = vi.fn();
    const onFatal = vi.fn();
    const handlers = buildCrashLoggingHandlers({ tracer, onFatal });

    handlers.unhandledRejection("string-reason");

    expect(tracer).toHaveBeenCalledWith(
      "FATAL unhandledRejection",
      expect.objectContaining({ message: "string-reason" })
    );
    const fatalArgs = onFatal.mock.calls[0];
    expect(fatalArgs[0]).toBe("unhandledRejection");
    expect(fatalArgs[1]).toBeInstanceOf(Error);
    expect((fatalArgs[1] as Error).message).toBe("string-reason");
  });

  it("unhandledRejection: undefined reason 不会爆炸", () => {
    const tracer = vi.fn();
    const onFatal = vi.fn();
    const handlers = buildCrashLoggingHandlers({ tracer, onFatal });

    handlers.unhandledRejection(undefined);

    expect(tracer).toHaveBeenCalledTimes(1);
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect((onFatal.mock.calls[0][1] as Error).message.length).toBeGreaterThan(0);
  });

  it("unhandledRejection: 对象 reason 序列化为 JSON 文本", () => {
    const tracer = vi.fn();
    const onFatal = vi.fn();
    const handlers = buildCrashLoggingHandlers({ tracer, onFatal });

    handlers.unhandledRejection({ code: 500, msg: "internal" });

    const traceExtra = tracer.mock.calls[0][1] as { message: string };
    expect(traceExtra.message).toContain("500");
    expect(traceExtra.message).toContain("internal");
  });

  it("过长堆栈会被截断并打上 truncated 标记", () => {
    const tracer = vi.fn();
    const longStack = "x".repeat(8000);
    const err = Object.assign(new Error("long"), { stack: longStack });
    const handlers = buildCrashLoggingHandlers({ tracer, onFatal: () => {} });

    handlers.uncaughtException(err);

    const extra = tracer.mock.calls[0][1] as { stack: string };
    expect(extra.stack.length).toBeLessThanOrEqual(4100);
    expect(extra.stack).toContain("...(truncated)");
  });

  it("signalLogger: 写入信号名并调用 onSignal", () => {
    const tracer = vi.fn();
    const onSignal = vi.fn();
    const handlers = buildCrashLoggingHandlers({ tracer, onSignal });

    handlers.signalLogger("SIGINT");

    expect(tracer).toHaveBeenCalledWith("signal received", { signal: "SIGINT" });
    expect(onSignal).toHaveBeenCalledWith("SIGINT");
  });

  it("beforeExit: 写入退出码", () => {
    const tracer = vi.fn();
    const onBeforeExit = vi.fn();
    const handlers = buildCrashLoggingHandlers({ tracer, onBeforeExit });

    handlers.beforeExit(0);

    expect(tracer).toHaveBeenCalledWith("beforeExit", { code: 0 });
    expect(onBeforeExit).toHaveBeenCalledWith(0);
  });

  it("tracer 本身抛错也不会阻断 onFatal", () => {
    const tracer = vi.fn(() => {
      throw new Error("tracer broken");
    });
    const onFatal = vi.fn();
    const handlers = buildCrashLoggingHandlers({ tracer, onFatal });

    expect(() => handlers.uncaughtException(new Error("boom"))).not.toThrow();
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it("flush 本身抛错也不会阻断 onFatal", () => {
    const tracer = vi.fn();
    const flush = vi.fn(() => {
      throw new Error("flush broken");
    });
    const onFatal = vi.fn();
    const handlers = buildCrashLoggingHandlers({ tracer, flush, onFatal });

    expect(() => handlers.uncaughtException(new Error("boom"))).not.toThrow();
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it("默认 onFatal 行为：调用 console.error 然后 process.exit(1)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}__`);
    }) as never);

    const handlers = buildCrashLoggingHandlers({ tracer: () => {} });

    expect(() => handlers.uncaughtException(new Error("boom"))).toThrow("__exit_1__");
    expect(errSpy).toHaveBeenCalled();
    const message = (errSpy.mock.calls[0] ?? []).join(" ");
    expect(message).toContain("uncaughtException");
    expect(message).toContain("boom");

    errSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe("installCrashLogging", () => {
  it("注册所有相关事件监听器", () => {
    const before = {
      uncaught: process.listenerCount("uncaughtException"),
      rejection: process.listenerCount("unhandledRejection"),
      beforeExit: process.listenerCount("beforeExit"),
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
    };

    const { cleanup } = installCrashLogging({
      tracer: () => {},
      onFatal: () => {},
      onSignal: () => {},
    });

    expect(process.listenerCount("uncaughtException")).toBe(before.uncaught + 1);
    expect(process.listenerCount("unhandledRejection")).toBe(before.rejection + 1);
    expect(process.listenerCount("beforeExit")).toBe(before.beforeExit + 1);
    expect(process.listenerCount("SIGINT")).toBe(before.sigint + 1);
    expect(process.listenerCount("SIGTERM")).toBe(before.sigterm + 1);

    cleanup();

    expect(process.listenerCount("uncaughtException")).toBe(before.uncaught);
    expect(process.listenerCount("unhandledRejection")).toBe(before.rejection);
    expect(process.listenerCount("beforeExit")).toBe(before.beforeExit);
    expect(process.listenerCount("SIGINT")).toBe(before.sigint);
    expect(process.listenerCount("SIGTERM")).toBe(before.sigterm);
  });

  it("cleanup 之后再触发不会再调用 tracer", () => {
    const tracer = vi.fn();
    const { handlers, cleanup } = installCrashLogging({
      tracer,
      onFatal: () => {},
      onSignal: () => {},
    });

    handlers.signalLogger("SIGTERM");
    expect(tracer).toHaveBeenCalledTimes(1);

    cleanup();
    tracer.mockClear();

    process.emit("SIGTERM");
    expect(tracer).not.toHaveBeenCalled();
  });

  it("通过 process.emit 触发 SIGINT 会走到 tracer 与 onSignal", () => {
    const tracer = vi.fn();
    const onSignal = vi.fn();
    const { cleanup } = installCrashLogging({
      tracer,
      onFatal: () => {},
      onSignal,
    });

    try {
      process.emit("SIGINT");
      expect(tracer).toHaveBeenCalledWith("signal received", { signal: "SIGINT" });
      expect(onSignal).toHaveBeenCalledWith("SIGINT");
    } finally {
      cleanup();
    }
  });
});

describe("installEpipeGuard", () => {
  function fakeStream(): EventEmitter & { on: typeof EventEmitter.prototype.on; off: typeof EventEmitter.prototype.off } {
    return new EventEmitter() as unknown as EventEmitter & {
      on: typeof EventEmitter.prototype.on;
      off: typeof EventEmitter.prototype.off;
    };
  }

  it("吞掉 EPIPE 写错误并记录非致命 trace，不抛出", () => {
    const stream = fakeStream();
    const tracer = vi.fn();
    const cleanup = installEpipeGuard([stream as never], { tracer });

    const err = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
    expect(() => stream.emit("error", err)).not.toThrow();
    expect(tracer).toHaveBeenCalledWith(
      "stdio write error (non-fatal)",
      expect.objectContaining({ code: "EPIPE" }),
    );

    cleanup();
  });

  it("其它 IO 错误同样非致命（日志失败不能拖垮服务）", () => {
    const stream = fakeStream();
    const tracer = vi.fn();
    const cleanup = installEpipeGuard([stream as never], { tracer });

    const err = Object.assign(new Error("permission denied"), { code: "EACCES" });
    expect(() => stream.emit("error", err)).not.toThrow();
    expect(tracer).toHaveBeenCalledWith(
      "stdio write error (non-fatal)",
      expect.objectContaining({ code: "EACCES" }),
    );

    cleanup();
  });

  it("cleanup 后不再监听，错误可正常传播", () => {
    const stream = fakeStream();
    const tracer = vi.fn();
    const cleanup = installEpipeGuard([stream as never], { tracer });
    cleanup();

    expect(() => stream.emit("error", new Error("boom"))).toThrow("boom");
    expect(tracer).not.toHaveBeenCalled();
  });

  it("默认同时守护 stdout 与 stderr", () => {
    const stdoutBefore = process.stdout.listenerCount("error");
    const stderrBefore = process.stderr.listenerCount("error");
    const cleanup = installEpipeGuard(undefined, { tracer: () => {} });
    try {
      expect(process.stdout.listenerCount("error")).toBe(stdoutBefore + 1);
      expect(process.stderr.listenerCount("error")).toBe(stderrBefore + 1);
    } finally {
      cleanup();
      expect(process.stdout.listenerCount("error")).toBe(stdoutBefore);
      expect(process.stderr.listenerCount("error")).toBe(stderrBefore);
    }
  });
});

describe("setupFileLogging", () => {
  it("flush 后继续写日志不会触发 write after end，且日志已落盘", async () => {
    const originalLog = console.log;
    const originalError = console.error;
    console.log = vi.fn() as never;
    console.error = vi.fn() as never;
    const dir = await mkdtemp(join(tmpdir(), "chatccc-log-"));

    try {
      const fileLog = setupFileLogging(dir, "index");

      console.log("before flush");
      fileLog.flush();

      expect(() => console.error("after flush")).not.toThrow();
      fileLog.flush();

      const content = await readFile(fileLog.logPath, "utf8");
      expect(content).toContain("[LOG] before flush");
      expect(content).toContain("[ERR] after flush");
    } finally {
      console.log = originalLog;
      console.error = originalError;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("日志参数无法 JSON 序列化时也不会让 console 调用抛错", async () => {
    const originalLog = console.log;
    const originalError = console.error;
    console.log = vi.fn() as never;
    console.error = vi.fn() as never;
    const dir = await mkdtemp(join(tmpdir(), "chatccc-log-"));

    try {
      const fileLog = setupFileLogging(dir, "index");
      const circular: Record<string, unknown> = { name: "root" };
      circular.self = circular;

      expect(() => console.log("circular", circular)).not.toThrow();
      fileLog.flush();

      const content = await readFile(fileLog.logPath, "utf8");
      expect(content).toContain("[LOG] circular");
      expect(content).toContain("self");
    } finally {
      console.log = originalLog;
      console.error = originalError;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("console.warn 也会落盘并包含 WARN 级别标记", async () => {
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;
    console.log = vi.fn() as never;
    console.error = vi.fn() as never;
    console.warn = vi.fn() as never;
    const dir = await mkdtemp(join(tmpdir(), "chatccc-log-"));

    try {
      const fileLog = setupFileLogging(dir, "index");

      expect(() => console.warn("sdk warning")).not.toThrow();
      fileLog.flush();

      const content = await readFile(fileLog.logPath, "utf8");
      expect(content).toContain("[WARN] sdk warning");
    } finally {
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
