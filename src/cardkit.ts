import { BASE_URL, fileLog, ts } from "./config.ts";

// CardKit 是飞书的卡片流式更新 API，通过 cardElement.content 端点
// 对卡片上指定 element_id 的元素进行增量内容更新，实现打字机效果。
// 与普通卡片 PATCH 的区别：PATCH 是全量替换卡片 JSON，CardKit 是
// 由飞书客户端自行渲染增量文本，用户看到的是逐字出现的效果。
// 参考: https://open.feishu.cn/document/uYjLw4iNukDO6YDN4ITM4MjM

const CARDKIT_REQUEST_TIMEOUT_MS = 15_000;

async function fetchCardKit(
  url: string,
  init: Parameters<typeof fetch>[1],
  operation: string,
): Promise<{ resp: Response; respText: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CARDKIT_REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });
    const respText = await resp.text();
    return { resp, respText };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      console.error(`[${ts()}] [CARDIKT] ${operation} TIMEOUT after ${CARDKIT_REQUEST_TIMEOUT_MS}ms`);
      fileLog.flush();
      throw new Error(`${operation} timeout after ${CARDKIT_REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function createCardKitCard(token: string, cardJson: string): Promise<string> {
  const body = JSON.stringify({ type: "card_json", data: cardJson });
  const { resp, respText } = await fetchCardKit(`${BASE_URL}/cardkit/v1/cards`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body,
  }, "createCard");
  let data: { code: number; msg?: string; data?: { card_id?: string } };
  try {
    data = JSON.parse(respText);
  } catch {
    console.error(`[${ts()}] [CARDIKT] createCard: invalid JSON response (status=${resp.status}) body=${respText.slice(0, 500)}`);
    fileLog.flush();
    throw new Error(`CardKit create: invalid JSON response (status=${resp.status})`);
  }
  if (data.code !== 0) {
    console.error(`[${ts()}] [CARDIKT] createCard FAIL: status=${resp.status} code=${data.code} msg="${data.msg}" body=${respText.slice(0, 500)}`);
    fileLog.flush();
    throw new Error(`CardKit create: [${data.code}] ${data.msg}`);
  }
  console.log(`[${ts()}] [CARDIKT] createCard OK cardId=${data.data?.card_id ?? "(none)"}`);
  return data.data?.card_id ?? "";
}

export async function setCardKitSettings(
  token: string,
  cardId: string,
  settings: Record<string, unknown>,
  sequence: number
): Promise<void> {
  const { resp, respText } = await fetchCardKit(`${BASE_URL}/cardkit/v1/cards/${cardId}/settings`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ settings: JSON.stringify(settings), sequence }),
  }, `settings cardId=${cardId} seq=${sequence}`);
  let data: { code: number; msg?: string };
  try { data = JSON.parse(respText); } catch {
    console.error(`[${ts()}] [CARDIKT] settings FAIL: invalid JSON cardId=${cardId} seq=${sequence} status=${resp.status}`);
    fileLog.flush();
    throw new Error(`CardKit settings: invalid JSON (status=${resp.status})`);
  }
  if (data.code !== 0) {
    console.error(`[${ts()}] [CARDIKT] settings FAIL: cardId=${cardId} seq=${sequence} status=${resp.status} code=${data.code} msg="${data.msg}"`);
    fileLog.flush();
    throw new Error(`CardKit settings: [${data.code}] ${data.msg}`);
  }
  console.log(`[${ts()}] [CARDIKT] settings OK cardId=${cardId} seq=${sequence}`);
}

export async function streamCardKitElement(
  token: string,
  cardId: string,
  elementId: string,
  content: string,
  sequence: number
): Promise<void> {
  const { resp, respText } = await fetchCardKit(
    `${BASE_URL}/cardkit/v1/cards/${cardId}/elements/${elementId}/content`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content, sequence }),
    },
    `streamElement cardId=${cardId} element=${elementId} seq=${sequence}`,
  );
  let data: { code: number; msg?: string };
  try { data = JSON.parse(respText); } catch {
    console.error(`[${ts()}] [CARDIKT] streamElement FAIL: invalid JSON cardId=${cardId} element=${elementId} seq=${sequence} status=${resp.status}`);
    fileLog.flush();
    throw new Error(`CardKit stream: invalid JSON (status=${resp.status})`);
  }
  if (data.code !== 0) {
    console.error(`[${ts()}] [CARDIKT] streamElement FAIL: cardId=${cardId} element=${elementId} seq=${sequence} status=${resp.status} code=${data.code} msg="${data.msg}"`);
    fileLog.flush();
    throw new Error(`CardKit stream: [${data.code}] ${data.msg}`);
  }
  // success log is intentionally sparse — uncomment to debug streaming throughput
  // console.log(`[${ts()}] [CARDIKT] streamElement OK cardId=${cardId} seq=${sequence}`);
}

export async function updateCardKitCard(
  token: string,
  cardId: string,
  cardJson: string,
  sequence: number
): Promise<void> {
  const { resp, respText } = await fetchCardKit(`${BASE_URL}/cardkit/v1/cards/${cardId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ card: { type: "card_json", data: cardJson }, sequence }),
  }, `updateCard cardId=${cardId} seq=${sequence}`);
  let data: { code: number; msg?: string };
  try { data = JSON.parse(respText); } catch {
    console.error(`[${ts()}] [CARDIKT] updateCard FAIL: invalid JSON cardId=${cardId} seq=${sequence} status=${resp.status}`);
    fileLog.flush();
    throw new Error(`CardKit update: invalid JSON (status=${resp.status})`);
  }
  if (data.code !== 0) {
    console.error(`[${ts()}] [CARDIKT] updateCard FAIL: cardId=${cardId} seq=${sequence} status=${resp.status} code=${data.code} msg="${data.msg}"`);
    fileLog.flush();
    throw new Error(`CardKit update: [${data.code}] ${data.msg}`);
  }
  console.log(`[${ts()}] [CARDIKT] updateCard OK cardId=${cardId} seq=${sequence}`);
}

export async function sendCardKitMessage(
  token: string,
  chatId: string,
  cardId: string
): Promise<string> {
  const payload = { receive_id: chatId, msg_type: "interactive", content: JSON.stringify({ type: "card", data: { card_id: cardId } }) };
  const url = `${BASE_URL}/im/v1/messages?receive_id_type=chat_id`;
  const { resp, respText } = await fetchCardKit(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  }, `sendMessage cardId=${cardId} chatId=${chatId}`);
  let data: { code: number; msg?: string; data?: { message_id?: string } };
  try { data = JSON.parse(respText); } catch {
    console.error(`[${ts()}] [CARDIKT] sendMessage FAIL: invalid JSON cardId=${cardId} chatId=${chatId} status=${resp.status}`);
    fileLog.flush();
    throw new Error(`sendCardKitMessage: invalid JSON (status=${resp.status})`);
  }
  if (data.code !== 0) {
    console.error(`[${ts()}] [CARDIKT] sendMessage FAIL: status=${resp.status} code=${data.code} msg="${data.msg}" cardId=${cardId} chatId=${chatId}`);
    fileLog.flush();
    throw new Error(`[${data.code}] ${data.msg}`);
  }
  console.log(`[${ts()}] [CARDIKT] sendMessage OK cardId=${cardId} chatId=${chatId} msgId=${data.data?.message_id ?? "(none)"}`);
  return data.data?.message_id ?? "";
}