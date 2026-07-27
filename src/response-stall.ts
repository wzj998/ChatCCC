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
): ResponseProgressObservation | undefined {
  if (!isMonitoredPhase) return undefined;
  if (previous?.totalChars === totalChars) return previous;
  return { totalChars, unchangedSince: now };
}

export function hasResponseStalled(
  observation: ResponseProgressObservation | undefined,
  now: number,
  timeoutMs: number,
): boolean {
  return observation !== undefined && now - observation.unchangedSince >= timeoutMs;
}
