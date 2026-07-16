/** A snapshot of response output progress while the Agent is generating a reply. */
export interface ResponseProgressObservation {
  totalChars: number;
  unchangedSince: number;
}

/**
 * Tracks how long the displayed response character count has remained unchanged.
 * Leaving the responding phase clears the window; returning starts a fresh one.
 */
export function observeResponseProgress(
  previous: ResponseProgressObservation | undefined,
  isResponding: boolean,
  totalChars: number,
  now = Date.now(),
): ResponseProgressObservation | undefined {
  if (!isResponding) return undefined;
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
