import type { Bot } from "grammy";
import { config } from "../config.js";

export async function sendOwnerMessage(
  bot: Bot,
  text: string,
  parseMode: "HTML" | "MarkdownV2" = "HTML",
): Promise<void> {
  await bot.api.sendMessage(config.TELEGRAM_OWNER_CHAT_ID, text, {
    parse_mode: parseMode,
  });
}

export function truncateAndSend(
  bot: Bot,
  chatId: number,
  text: string,
  parseMode: "HTML" | "MarkdownV2" = "HTML",
): Promise<void[]> {
  const MAX_LEN = 4000;
  if (text.length <= MAX_LEN) {
    return Promise.all([
      bot.api.sendMessage(chatId, text, { parse_mode: parseMode }).then(() => {}),
    ]);
  }
  const chunks: Promise<void>[] = [];
  for (let i = 0; i < text.length; i += MAX_LEN) {
    chunks.push(
      bot.api.sendMessage(chatId, text.slice(i, i + MAX_LEN), { parse_mode: parseMode }).then(() => {}),
    );
  }
  return Promise.all(chunks);
}
