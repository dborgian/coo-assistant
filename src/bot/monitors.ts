import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { Bot } from "grammy";
import { TelegramClient } from "telegram";
import { NewMessage, type NewMessageEvent } from "telegram/events/index.js";
import { StringSession } from "telegram/sessions/index.js";
import { agent } from "../core/agent.js";
import { config } from "../config.js";
import { db } from "../models/database.js";
import { messageLogs } from "../models/schema.js";
import { logger } from "../utils/logger.js";

let userbot: TelegramClient | null = null;
let botRef: Bot | null = null;

export async function startUserbot(bot: Bot): Promise<boolean> {
  botRef = bot;

  if (!config.TELEGRAM_API_ID || !config.TELEGRAM_API_HASH) {
    logger.warn("GramJS credentials not configured — chat monitoring disabled");
    return false;
  }

  const session = new StringSession(config.TELEGRAM_SESSION_STRING);

  userbot = new TelegramClient(
    session,
    config.TELEGRAM_API_ID,
    config.TELEGRAM_API_HASH,
    { connectionRetries: 5 },
  );

  // If no saved session, do interactive login
  if (!config.TELEGRAM_SESSION_STRING) {
    logger.info("No saved session — starting interactive login...");

    const rl = createInterface({ input: stdin, output: stdout });

    await userbot.start({
      phoneNumber: async () => {
        const phone = await rl.question("Enter your phone number: ");
        return phone;
      },
      password: async () => {
        const pwd = await rl.question("Enter your 2FA password (or press Enter if none): ");
        return pwd;
      },
      phoneCode: async () => {
        const code = await rl.question("Enter the code you received: ");
        return code;
      },
      onError: (err) => {
        logger.error({ err }, "GramJS login error");
      },
    });

    rl.close();

    // Print session string so user can save it to .env
    const savedSession = userbot.session.save() as unknown as string;
    logger.info("Login successful! Save this session string to your .env file as TELEGRAM_SESSION_STRING:");
    console.log("\n===== SESSION STRING (copy this) =====");
    console.log(savedSession);
    console.log("===== END SESSION STRING =====\n");
  } else {
    await userbot.connect();
  }

  logger.info("GramJS userbot connected");

  // Register event handler for new messages
  userbot.addEventHandler(
    (event: NewMessageEvent) => {
      onNewMessage(event).catch((err) =>
        logger.error({ err }, "Error processing message"),
      );
    },
    new NewMessage({}),
  );

  logger.info(
    { monitoredChats: config.MONITORED_CHAT_IDS },
    "Chat monitoring active",
  );

  return true;
}

async function onNewMessage(event: NewMessageEvent): Promise<void> {
  const message = event.message;
  const chatId = message.chatId?.toJSNumber?.() ?? Number(message.chatId);

  // Skip our own messages
  if (message.out) return;

  // Skip private chats (only monitor groups/supergroups)
  if (message.isPrivate) return;

  // Only process messages from monitored chats (if list is configured)
  if (
    config.MONITORED_CHAT_IDS.length &&
    !config.MONITORED_CHAT_IDS.includes(chatId)
  ) {
    return;
  }

  const messageText = message.text ?? "";
  if (!messageText.trim()) return;

  // Get sender and chat info
  const sender = await message.getSender();
  const chat = await message.getChat();

  // Skip messages from bots
  if (sender && "bot" in sender && sender.bot) return;

  const senderName =
    (sender && "firstName" in sender ? sender.firstName : null) ??
    (sender && "title" in sender ? sender.title : null) ??
    "Unknown";
  const chatTitle =
    (chat && "title" in chat ? chat.title : null) ?? senderName;
  const senderId = sender && "id" in sender
    ? Number(sender.id)
    : undefined;

  await handleNewMessage(chatId, senderName, chatTitle, messageText, senderId);
}

async function handleNewMessage(
  chatId: number,
  senderName: string,
  chatTitle: string,
  messageText: string,
  senderId?: number,
): Promise<void> {
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
  if (userbot) {
    await userbot.disconnect();
    userbot = null;
    logger.info("GramJS userbot disconnected");
  }
  botRef = null;
}
