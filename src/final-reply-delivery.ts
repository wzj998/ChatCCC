import type { PlatformAdapter } from "./platform-adapter.ts";
import { buildTableSummaryCards } from "./final-table-card.ts";

interface DeliveryDependencies {
  isSent(sessionId: string, turn: number): Promise<boolean>;
  markSent(sessionId: string, turn: number): Promise<void>;
  enabled(): boolean;
  sanitize(text: string): string;
  warn(message: string): void;
}

/** Serialize all final-delivery entry points for a turn, including display and fallback paths. */
export function createFinalReplyDelivery(deps: DeliveryDependencies) {
  const inFlight = new Map<string, Promise<boolean>>();
  return function deliver(platform: Pick<PlatformAdapter, "kind" | "sendText" | "sendRawCard">, chatId: string, sessionId: string, turn: number, text: string): Promise<boolean> {
    const key = JSON.stringify([sessionId, turn]);
    const pending = inFlight.get(key);
    if (pending) return pending;
    const task = (async () => {
      if (await deps.isSent(sessionId, turn)) return true;
      const sent = await platform.sendText(chatId, text).then(ok => ok !== false).catch(() => false);
      if (!sent) return false;
      // Persist the original before supplementary delivery: a summary failure must
      // never cause the original answer or already accepted summaries to be resent.
      await deps.markSent(sessionId, turn);
      if (platform.kind === "feishu" && deps.enabled()) {
        try {
          const cards = buildTableSummaryCards(deps.sanitize(text));
          for (const [index, json] of cards.entries()) {
            const ok = await platform.sendRawCard(chatId, json, { privacyApplied: true }).then(result => result !== false).catch(() => false);
            if (!ok) deps.warn(`table summary delivery failed: session=${sessionId} turn=${turn} part=${index + 1}/${cards.length}; original retained`);
          }
        } catch {
          deps.warn(`table summary preparation failed: session=${sessionId} turn=${turn}; original retained`);
        }
      }
      return true;
    })().finally(() => { inFlight.delete(key); });
    inFlight.set(key, task);
    return task;
  };
}
