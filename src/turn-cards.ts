import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { USER_DATA_DIR, ts } from "./config.ts";

// ---------------------------------------------------------------------------
// turn-cards.json — 每个 session 的卡片归属持久化
// 记录每个 turn 有哪些卡片（轮转会产生多张），以及每张卡片的状态
// ---------------------------------------------------------------------------

export const TURNS_DIR = join(USER_DATA_DIR, "state", "turns");

export interface TurnCardEntry {
  cardId: string;
  status: "active" | "done" | "stopped";
  createdAt: number;
}

export interface TurnCardsFile {
  sessionId: string;
  turns: { turnCount: number; cards: TurnCardEntry[] }[];
}

function getTurnCardsPath(sessionId: string): string {
  return join(TURNS_DIR, `${sessionId}.json`);
}

export function createEmptyTurnCards(sessionId: string): TurnCardsFile {
  return { sessionId, turns: [] };
}

export async function readTurnCards(sessionId: string): Promise<TurnCardsFile | null> {
  try {
    const raw = await readFile(getTurnCardsPath(sessionId), "utf-8");
    const parsed = JSON.parse(raw) as TurnCardsFile;
    if (parsed && typeof parsed.sessionId === "string" && Array.isArray(parsed.turns)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export async function writeTurnCards(sessionId: string, data: TurnCardsFile): Promise<void> {
  try {
    const filePath = getTurnCardsPath(sessionId);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error(`[${ts()}] Failed to write turn-cards for ${sessionId}: ${(err as Error).message}`);
  }
}

/** 向指定 turn 追加一张卡片并持久化。若 turn 不存在则创建。 */
export async function addCardToTurn(
  sessionId: string,
  turnCount: number,
  cardId: string,
): Promise<void> {
  const data = (await readTurnCards(sessionId)) ?? createEmptyTurnCards(sessionId);
  let turn = data.turns.find(t => t.turnCount === turnCount);
  if (!turn) {
    turn = { turnCount, cards: [] };
    data.turns.push(turn);
  }
  turn.cards.push({ cardId, status: "active", createdAt: Date.now() });
  await writeTurnCards(sessionId, data);
}

/** 将指定 turn 的所有 active 卡片标记为终态并持久化。返回被标记的 cardId 列表。 */
export async function finalizeTurnCards(
  sessionId: string,
  turnCount: number,
  finalStatus: "done" | "stopped",
): Promise<string[]> {
  const data = await readTurnCards(sessionId);
  if (!data) return [];
  const turn = data.turns.find(t => t.turnCount === turnCount);
  if (!turn) return [];
  const finalized: string[] = [];
  for (const card of turn.cards) {
    if (card.status === "active") {
      card.status = finalStatus;
      finalized.push(card.cardId);
    }
  }
  if (finalized.length > 0) {
    await writeTurnCards(sessionId, data);
  }
  return finalized;
}

/** 将指定 turn 中的一张 active 卡片标记为 done（轮转时用），并持久化。 */
export async function markCardDone(
  sessionId: string,
  turnCount: number,
  cardId: string,
): Promise<void> {
  const data = await readTurnCards(sessionId);
  if (!data) return;
  const turn = data.turns.find(t => t.turnCount === turnCount);
  if (!turn) return;
  const card = turn.cards.find(c => c.cardId === cardId && c.status === "active");
  if (!card) return;
  card.status = "done";
  await writeTurnCards(sessionId, data);
}

/** 清理 session 的 turn-cards 文件 */
export async function removeTurnCards(sessionId: string): Promise<void> {
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(getTurnCardsPath(sessionId));
  } catch {
    // 文件不存在，忽略
  }
}