import {
  DEFAULT_BUILTIN_CONTEXT_DIR,
  getBuiltinContextSession,
  latestBuiltinSessionForCwd,
  newBuiltinSessionId,
  normalizeBuiltinSessionId,
} from "./context.js";

export type BuiltinResumeRequest = true | string | undefined;

export interface ResolveBuiltinSessionOptions {
  cwd: string;
  contextDir?: string;
  resume?: BuiltinResumeRequest;
  now?: Date;
  randomSuffix?: string;
}

export interface ResolvedBuiltinSession {
  mode: "new" | "resumed";
  sessionId: string;
}

export function resolveBuiltinSession(options: ResolveBuiltinSessionOptions): ResolvedBuiltinSession {
  const contextDir = options.contextDir ?? DEFAULT_BUILTIN_CONTEXT_DIR;

  if (options.resume === true) {
    const latest = latestBuiltinSessionForCwd(options.cwd, contextDir);
    if (!latest) {
      throw new Error(`No resumable DeepCCC session found for cwd: ${options.cwd}`);
    }
    return { mode: "resumed", sessionId: latest.sessionId };
  }

  if (typeof options.resume === "string") {
    const sessionId = normalizeBuiltinSessionId(options.resume);
    const existing = getBuiltinContextSession(sessionId, contextDir);
    if (!existing) {
      throw new Error(`DeepCCC session not found: ${sessionId}`);
    }
    return { mode: "resumed", sessionId };
  }

  return {
    mode: "new",
    sessionId: newBuiltinSessionId(options.now, options.randomSuffix),
  };
}
