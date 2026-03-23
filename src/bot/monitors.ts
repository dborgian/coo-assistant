import type { Bot } from "grammy";
import { agent } from "../core/agent.js";
import { config } from "../config.js";
import { db } from "../models/database.js";
import { messageLogs } from "../models/schema.js";
import { logger } from "../utils/logger.js";

// GramJS userbot placeholder
// TODO: Implement GramJS (telegram package) userbot for chat monitoring
// GramJS is the TypeScript equivalent of Python's Telethon

let botRef: Bot | null = null;

export async function startUserbot(bot: Bot): Promise<boolean> {
  botRef = bot;

  if (!config.TELEGRAM_API_ID || !config.TELEGRAM_API_HASH) {
    logger.warn("GramJS credentials not configured — chat monitoring disabled");
    return false;
  }

  // TODO: Initialize GramJS TelegramClient
  // const { TelegramClient } = await import("telegram");
  // const { StringSession } = await import("telegram/sessions");
  //
  // const client = new TelegramClient(
  //   new StringSession(savedSession),
  //   config.TELEGRAM_API_ID,
  //   config.TELEGRAM_API_HASH,
  //   { connectionRetries: 5 }
  // );
  //
  // await client.start({ ... });
  //
  // client.addEventHandler(async (event) => {
  //   // Process new messages from monitored chats
  //   await handleNewMessage(event);
  // }, new NewMessage({}));

  logger.info("Chat monitoring — GramJS integration pending setup");
  return false;
}

export async function handleNewMessage(
  chatId: number,
  senderName: string,
  chatTitle: string,
  messageText: string,
  senderId?: number,
): Promise<void> {
  if (!messageText.trim()) return;

  // Only process messages from monitored chats
  if (
    config.MONITORED_CHAT_IDS.length &&
    !config.MONITORED_CHAT_IDS.includes(chatId)
  ) {
    return;
  }

  logger.info(
    { chat: chatTitle, sender: senderName, preview: messageText.slice(0, 80) },
    "New message detected",
  );

  // Use AI to classify urgency
  const classification = await agent.classifyMessageUrgency(
    messageText,
    senderName,
    chatTitle,
  );

  db.insert(messageLogs)
    .values({
      source: "telegram",
      chatId,
      chatTitle,
      senderName,
      senderId: senderId ?? null,
      content: messageText,
      urgency: classification.urgency,
      needsReply: classification.needs_reply,
    })
    .run();

  // Notify owner if high urgency or needs reply
  if (
    classification.needs_reply ||
    ["high", "critical"].includes(classification.urgency)
  ) {
    const urgency = classification.urgency.toUpperCase();
    const summary = classification.summary || messageText.slice(0, 150);
    const notification =
      `<b>[${urgency}] New message needs attention</b>\n\n` +
      `<b>Chat:</b> ${chatTitle}\n` +
      `<b>From:</b> ${senderName}\n` +
      `<b>Summary:</b> ${summary}\n` +
      `<b>Reason:</b> ${classification.reason ?? "N/A"}`;

    try {
      await botRef?.api.sendMessage(
        config.TELEGRAM_OWNER_CHAT_ID,
        notification,
        { parse_mode: "HTML" },
      );
    } catch (err) {
      logger.error({ err }, "Failed to notify owner");
    }
  }
}

export async function stopUserbot(): Promise<void> {
  // TODO: Disconnect GramJS client
  botRef = null;
  logger.info("Chat monitoring stopped");
}
