import type { Bot } from "grammy";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../models/database.js";
import { employees } from "../models/schema.js";
import { logger } from "./logger.js";

export async function sendOwnerMessage(
  bot: Bot,
  text: string,
  parseMode: "HTML" | "MarkdownV2" = "HTML",
): Promise<void> {
  await bot.api.sendMessage(config.TELEGRAM_OWNER_CHAT_ID, text, {
    parse_mode: parseMode,
  });
}

/**
 * Send a notification to the task's assignee (if they have a telegramUserId)
 * AND always to the owner. Avoids duplicate if assignee IS the owner.
 */
export async function notifyAssigneeAndOwner(
  bot: Bot,
  assignedTo: string | null,
  text: string,
  parseMode?: "HTML" | "MarkdownV2",
): Promise<void> {
  const opts = parseMode ? { parse_mode: parseMode as "HTML" | "MarkdownV2" } : undefined;
  let assigneeTelegramId: number | null = null;

  if (assignedTo) {
    try {
      const [emp] = await db
        .select({ telegramUserId: employees.telegramUserId })
        .from(employees)
        .where(eq(employees.id, assignedTo))
        .limit(1);
      assigneeTelegramId = emp?.telegramUserId ?? null;
    } catch (err) {
      logger.error({ err, assignedTo }, "Failed to lookup assignee for notification");
    }
  }

  // Send to assignee if they have Telegram and are not the owner
  if (assigneeTelegramId && assigneeTelegramId !== config.TELEGRAM_OWNER_CHAT_ID) {
    try {
      await bot.api.sendMessage(assigneeTelegramId, text, opts);
    } catch (err) {
      logger.debug({ err, assigneeTelegramId }, "Failed to send notification to assignee");
    }
  }

  // Always send to owner
  await bot.api.sendMessage(config.TELEGRAM_OWNER_CHAT_ID, text, opts);
}

/**
 * Send a message to a specific employee by their employee ID (DB uuid).
 * Does NOT send to owner. Returns true if message was sent.
 */
export async function sendEmployeeMessage(
  bot: Bot,
  employeeId: string,
  text: string,
  parseMode?: "HTML" | "MarkdownV2",
): Promise<boolean> {
  try {
    const [emp] = await db
      .select({ telegramUserId: employees.telegramUserId })
      .from(employees)
      .where(eq(employees.id, employeeId))
      .limit(1);

    if (!emp?.telegramUserId) return false;

    const opts = parseMode ? { parse_mode: parseMode as "HTML" | "MarkdownV2" } : undefined;
    await bot.api.sendMessage(emp.telegramUserId, text, opts);
    return true;
  } catch (err) {
    logger.debug({ err, employeeId }, "Failed to send message to employee");
    return false;
  }
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
