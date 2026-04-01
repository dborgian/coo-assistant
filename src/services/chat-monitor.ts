import { and, eq, lt } from "drizzle-orm";
import { sendOwnerNotification } from "../utils/notify.js";
import { db } from "../models/database.js";
import { messageLogs } from "../models/schema.js";
import { logger } from "../utils/logger.js";
import { getRedis } from "../utils/conversation-cache.js";

const REMINDER_TTL = 4 * 60 * 60; // 4 hours — don't re-notify for the same message within this window
// In-memory fallback when Redis is unavailable
const remindedIds = new Set<string>();

export async function checkPendingMessages(): Promise<void> {
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

  const staleMessages = await db
    .select()
    .from(messageLogs)
    .where(
      and(
        eq(messageLogs.needsReply, true),
        eq(messageLogs.replied, false),
        eq(messageLogs.notifiedOwner, true),
        lt(messageLogs.receivedAt, twoHoursAgo),
      ),
    );

  if (!staleMessages.length) return;

  const redis = getRedis();
  const toNotify: typeof staleMessages = [];

  // Filter messages already reminded in the last 4 hours
  for (const msg of staleMessages) {
    const key = `chatrem:${msg.id}`;
    try {
      if (redis) {
        const exists = await redis.exists(key);
        if (exists) continue;
      } else {
        if (remindedIds.has(msg.id)) continue;
      }
      toNotify.push(msg);
    } catch {
      toNotify.push(msg); // on error, allow through
    }
  }

  if (!toNotify.length) return;

  let reminderText = "<b>Pending Reply Reminder</b>\n\n";
  for (const msg of toNotify) {
    const ageMs = Date.now() - new Date(msg.receivedAt!).getTime();
    const hours = Math.floor(ageMs / (1000 * 60 * 60));
    reminderText += `- <b>${msg.chatTitle}</b> from ${msg.senderName} (${hours}h ago): ${msg.content.slice(0, 100)}...\n`;
  }

  try {
    await sendOwnerNotification(reminderText);
    // Mark as reminded
    for (const msg of toNotify) {
      const key = `chatrem:${msg.id}`;
      if (redis) {
        await redis.set(key, "1", "EX", REMINDER_TTL).catch(() => {});
      } else {
        remindedIds.add(msg.id);
        // Prevent unbounded growth of in-memory set
        if (remindedIds.size > 500) remindedIds.clear();
      }
    }
    logger.info({ count: toNotify.length }, "Sent pending reply reminder");
  } catch (err) {
    logger.error({ err }, "Failed to send reminder");
  }
}
