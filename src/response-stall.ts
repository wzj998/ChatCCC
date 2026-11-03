/** ChatCCC's streamed-response watchdog; not a provider or tool-execution timeout. */
export function getDefaultResponseStallTimeoutMs(tool: string): number {
  return (tool === "ccc" ? 10 : 3) * 60 * 1000;
}

export function formatResponseStallRecoveryExhaustedNotice(tool: string): string {
  const minutes = getDefaultResponseStallTimeoutMs(tool) / 60_000;
  return `⚠️ 自动续跑仍连续 ${minutes} 分钟没有生成新回复，本次不再自动继续。`;
}

/** A snapshot of visible output progress while the Agent is starting or replying. */
export interface ResponseProgressObservation {
  totalChars: number;
  unchangedSince: number;
}

/**
 * Tracks how long the displayed output character count has remained unchanged.
 * Leaving a monitored phase clears the window; returning starts a fresh one.
 */
export function observeResponseProgress(
  previous: ResponseProgressObservation | undefined,
  isMonitoredPhase: boolean,
  totalChars: number,
  now = Date.now(),
  heartbeat = false,
): ResponseProgressObservation | undefined {
  if (!isMonitoredPhase) return undefined;
  if (!heartbeat && previous?.totalChars === totalChars) return previous;
  return { totalChars, unchangedSince: now };
}

export function hasResponseStalled(
  observation: ResponseProgressObservation | undefined,
  now: number,
  timeoutMs: number,
): boolean {
  return observation !== undefined && now - observation.unchangedSince >= timeoutMs;
}
