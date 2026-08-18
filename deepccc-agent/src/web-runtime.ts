import { randomUUID } from "node:crypto";

import { ChatSession, type ChatEvent, type ChatSessionConfig } from "./index.js";
import { readBuiltinContextState } from "./context.js";
import type { PermissionAnswer, PermissionRequest, PermissionResolver } from "./permissions.js";
import {
  WebSessionStore,
  type CreateWebSessionInput,
  type UpdateWebSessionInput,
  type WebSessionMeta,
} from "./web-session-store.js";

export interface WebRuntimeConfig extends ChatSessionConfig {
  provider: "openai" | "anthropic";
  apiKey: string;
  baseURL: string;
  model: string;
  subModel: string;
  effort: string;
  contextWindow: number;
  streaming: boolean;
}

export interface WebRuntimeEvent {
  eventId: number;
  sessionId: string;
  at: string;
  type: "user" | "agent" | "run_started" | "run_finished" | "approval" | "approval_resolved" | "session_updated" | "session_deleted";
  data: unknown;
}

export interface PendingWebApproval extends PermissionRequest {
  approvalId: string;
  sessionId: string;
  createdAt: string;
}

export interface WebSessionFactoryInput {
  meta: WebSessionMeta;
  config: WebRuntimeConfig;
  permissionResolver: PermissionResolver;
}

export interface WebSessionAgent {
  chat(input: string, signal?: AbortSignal): AsyncIterable<ChatEvent>;
}

export interface DeepCccWebRuntimeOptions {
  store?: WebSessionStore;
  loadConfig: () => WebRuntimeConfig;
  sessionFactory?: (input: WebSessionFactoryInput) => WebSessionAgent;
  approvalTimeoutMs?: number;
  now?: () => Date;
  idFactory?: () => string;
}

interface ActiveRun {
  runId: string;
  controller: AbortController;
  promise: Promise<void>;
}

interface ApprovalWaiter {
  approval: PendingWebApproval;
  resolve: (answer: PermissionAnswer) => void;
  timeout: ReturnType<typeof setTimeout>;
  ready: Promise<void>;
}

export class DeepCccWebRuntime {
  readonly store: WebSessionStore;
  private readonly loadConfig: () => WebRuntimeConfig;
  private readonly sessionFactory: (input: WebSessionFactoryInput) => WebSessionAgent;
  private readonly approvalTimeoutMs: number;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly agents = new Map<string, WebSessionAgent>();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly startingRuns = new Map<string, AbortController>();
  private readonly sessionMutations = new Set<string>();
  private readonly events = new Map<string, WebRuntimeEvent[]>();
  private readonly listeners = new Map<string, Set<(event: WebRuntimeEvent) => void>>();
  private readonly globalListeners = new Set<(event: WebRuntimeEvent) => void>();
  private readonly approvals = new Map<string, ApprovalWaiter>();
  private nextEventId = 1;

  constructor(options: DeepCccWebRuntimeOptions) {
    this.store = options.store ?? new WebSessionStore();
    this.loadConfig = options.loadConfig;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? 5 * 60_000;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.sessionFactory = options.sessionFactory ?? ((input) => new ChatSession({
      provider: input.config.provider,
      apiKey: input.config.apiKey,
      baseURL: input.config.baseURL,
      model: input.meta.model || input.config.model,
      subModel: input.meta.subModel || input.config.subModel,
      effort: input.meta.effort || input.config.effort,
      maxOutputTokens: input.config.maxOutputTokens,
      streaming: input.config.streaming,
    }, {
      cwd: input.meta.cwd,
      persist: true,
      sessionId: input.meta.sessionId,
      contextWindow: input.config.contextWindow,
      permissionMode: "ask",
      permissionResolver: input.permissionResolver,
    }));
  }

  async listSessions() {
    const sessions = await this.store.list();
    return sessions.map((meta) => ({ ...meta, status: this.activeRuns.has(meta.sessionId) ? "running" : "idle" }));
  }

  async createSession(input: CreateWebSessionInput): Promise<WebSessionMeta> {
    const config = this.loadConfig();
    const session = await this.store.create({
      ...input,
      model: input.model ?? config.model,
      subModel: input.subModel ?? config.subModel,
      effort: input.effort ?? config.effort,
    });
    this.emit(session.sessionId, "session_updated", session);
    return session;
  }

  async getSession(sessionId: string) {
    const meta = await this.requireSession(sessionId);
    const context = readBuiltinContextState(sessionId, this.store.rootDir);
    const pendingApproval = [...this.approvals.values()].find((entry) => entry.approval.sessionId === sessionId)?.approval ?? null;
    return {
      ...meta,
      status: this.activeRuns.has(sessionId) ? "running" : "idle",
      runId: this.activeRuns.get(sessionId)?.runId ?? null,
      messages: context?.messages ?? [],
      summary: context?.summary ?? "",
      events: this.events.get(sessionId) ?? [],
      pendingApproval,
      approvals: meta.approvals,
    };
  }

  async updateSession(sessionId: string, patch: UpdateWebSessionInput): Promise<WebSessionMeta> {
    if (this.activeRuns.has(sessionId) || this.startingRuns.has(sessionId) || this.sessionMutations.has(sessionId)) {
      throw new Error("Cannot change session settings while another session operation is running");
    }
    this.sessionMutations.add(sessionId);
    try {
      const updated = await this.store.update(sessionId, patch);
      this.agents.delete(sessionId);
      this.emit(sessionId, "session_updated", updated);
      return updated;
    } finally {
      this.sessionMutations.delete(sessionId);
    }
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    if (this.activeRuns.has(sessionId) || this.startingRuns.has(sessionId) || this.sessionMutations.has(sessionId)) {
      throw new Error("Stop the running session before deleting it");
    }
    this.sessionMutations.add(sessionId);
    try {
      this.agents.delete(sessionId);
      const deleted = await this.store.delete(sessionId);
      if (deleted) {
        this.emit(sessionId, "session_deleted", { sessionId });
        this.events.delete(sessionId);
      }
      return deleted;
    } finally {
      this.sessionMutations.delete(sessionId);
    }
  }

  async sendMessage(sessionId: string, text: string): Promise<{ runId: string }> {
    const prompt = text.trim();
    if (!prompt) throw new Error("Message must not be empty");
    const controller = new AbortController();
    if (this.activeRuns.has(sessionId) || this.startingRuns.has(sessionId) || this.sessionMutations.has(sessionId)) {
      throw new Error("This session is already running");
    }
    this.startingRuns.set(sessionId, controller);
    try {
      let meta = await this.requireSession(sessionId);
      if (meta.title === "新会话" || meta.title === "New session" || meta.title === meta.cwd.split(/[\\/]/).at(-1)) {
        meta = await this.store.update(sessionId, { title: prompt.replace(/\s+/g, " ").slice(0, 42) });
      }
      if (controller.signal.aborted) throw new DOMException("The session start was stopped", "AbortError");
      const runId = `run-${this.idFactory()}`;
      this.events.set(sessionId, []);
      this.emit(sessionId, "user", { text: prompt });
      const promise = Promise.resolve()
        .then(() => this.run(meta, prompt, runId, controller.signal))
        .finally(() => {
          this.activeRuns.delete(sessionId);
          this.emit(sessionId, "session_updated", { sessionId, status: "idle" });
        });
      this.activeRuns.set(sessionId, { runId, controller, promise });
      this.emit(sessionId, "run_started", { runId });
      void promise.catch(() => {});
      return { runId };
    } finally {
      this.startingRuns.delete(sessionId);
    }
  }

  async stopSession(sessionId: string): Promise<boolean> {
    const active = this.activeRuns.get(sessionId);
    const starting = this.startingRuns.get(sessionId);
    if (!active && !starting) return false;
    starting?.abort();
    if (!active) return true;
    active.controller.abort();
    const pending = [...this.approvals.entries()]
      .filter(([, waiter]) => waiter.approval.sessionId === sessionId);
    await Promise.all(pending.map(([approvalId, waiter]) =>
      this.finishApproval(approvalId, waiter, "deny", { stopped: true }).catch(() => {})));
    return true;
  }

  async waitForIdle(sessionId: string): Promise<void> {
    await this.activeRuns.get(sessionId)?.promise;
  }

  async resolveApproval(approvalId: string, answer: PermissionAnswer): Promise<boolean> {
    const waiter = this.approvals.get(approvalId);
    if (!waiter) return false;
    await this.finishApproval(approvalId, waiter, answer);
    return true;
  }

  subscribe(sessionId: string, listener: (event: WebRuntimeEvent) => void): () => void {
    const set = this.listeners.get(sessionId) ?? new Set();
    set.add(listener);
    this.listeners.set(sessionId, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(sessionId);
    };
  }

  subscribeAll(listener: (event: WebRuntimeEvent) => void): () => void {
    this.globalListeners.add(listener);
    return () => this.globalListeners.delete(listener);
  }

  private async run(meta: WebSessionMeta, prompt: string, runId: string, signal: AbortSignal): Promise<void> {
    try {
      const agent = this.agents.get(meta.sessionId) ?? this.createAgent(meta);
      this.agents.set(meta.sessionId, agent);
      for await (const event of agent.chat(prompt, signal)) this.emit(meta.sessionId, "agent", event);
      this.emit(meta.sessionId, "run_finished", { runId, outcome: signal.aborted ? "stopped" : "done" });
      await this.store.update(meta.sessionId, {});
    } catch (err) {
      const stopped = signal.aborted || (err instanceof Error && err.name === "AbortError");
      this.emit(meta.sessionId, "agent", { type: "error", message: stopped ? "已停止" : (err as Error).message });
      this.emit(meta.sessionId, "run_finished", { runId, outcome: stopped ? "stopped" : "error" });
    }
  }

  private createAgent(meta: WebSessionMeta): WebSessionAgent {
    return this.sessionFactory({
      meta,
      config: this.loadConfig(),
      permissionResolver: (request) => this.requestApproval(meta.sessionId, request),
    });
  }

  private requestApproval(sessionId: string, request: PermissionRequest): Promise<PermissionAnswer> {
    const approvalId = `approval-${this.idFactory()}`;
    const approval: PendingWebApproval = {
      ...request,
      approvalId,
      sessionId,
      createdAt: this.now().toISOString(),
    };
    return new Promise<PermissionAnswer>((resolve) => {
      const ready = this.store.addApproval(sessionId, {
        ...approval,
        status: "pending",
      });
      let waiter: ApprovalWaiter;
      const timeout = setTimeout(() => {
        void this.finishApproval(approvalId, waiter, "deny", { timedOut: true }).catch(() => {});
      }, this.approvalTimeoutMs);
      timeout.unref?.();
      waiter = { approval, resolve, timeout, ready };
      this.approvals.set(approvalId, waiter);
      void ready.then(() => {
        if (this.approvals.get(approvalId) !== waiter) return;
        this.emit(sessionId, "approval", approval);
      }).catch(() => {
        if (this.approvals.get(approvalId) !== waiter) return;
        clearTimeout(timeout);
        this.approvals.delete(approvalId);
        resolve("deny");
      });
    });
  }

  private async finishApproval(
    approvalId: string,
    waiter: ApprovalWaiter,
    answer: PermissionAnswer,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    if (this.approvals.get(approvalId) !== waiter) return;
    clearTimeout(waiter.timeout);
    this.approvals.delete(approvalId);
    try {
      await waiter.ready;
      await this.store.resolveApproval(waiter.approval.sessionId, approvalId, answer);
    } finally {
      waiter.resolve(answer);
      this.emit(waiter.approval.sessionId, "approval_resolved", { approvalId, answer, ...extra });
    }
  }

  private emit(sessionId: string, type: WebRuntimeEvent["type"], data: unknown): void {
    const event: WebRuntimeEvent = { eventId: this.nextEventId++, sessionId, at: this.now().toISOString(), type, data };
    const events = [...(this.events.get(sessionId) ?? []), event].slice(-500);
    this.events.set(sessionId, events);
    this.notifyListeners(this.listeners.get(sessionId) ?? [], event);
    if (["run_started", "run_finished", "session_updated", "session_deleted"].includes(type)) {
      this.notifyListeners(this.globalListeners, event);
    }
  }

  private notifyListeners(listeners: Iterable<(event: WebRuntimeEvent) => void>, event: WebRuntimeEvent): void {
    for (const listener of listeners) {
      try { listener(event); } catch { /* a disconnected SSE client must not affect the Agent run */ }
    }
  }

  private async requireSession(sessionId: string): Promise<WebSessionMeta> {
    const meta = await this.store.get(sessionId);
    if (!meta) throw new Error(`DeepCCC web session not found: ${sessionId}`);
    return meta;
  }
}
