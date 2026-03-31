import { and, eq, lt } from "drizzle-orm";
import { sendOwnerNotification } from "../utils/notify.js";
import { db } from "../models/database.js";
import { messageLogs } from "../models/schema.js";
import { logger } from "../utils/logger.js";

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

  let reminderText = "<b>Pending Reply Reminder</b>\n\n";
  for (const msg of staleMessages) {
    const ageMs = Date.now() - new Date(msg.receivedAt!).getTime();
    const hours = Math.floor(ageMs / (1000 * 60 * 60));
    reminderText += `- <b>${msg.chatTitle}</b> from ${msg.senderName} (${hours}h ago): ${msg.content.slice(0, 100)}...\n`;
  }

  try {
    await sendOwnerNotification(reminderText);
    logger.info({ count: staleMessages.length }, "Sent pending reply reminder");
  } catch (err) {
    logger.error({ err }, "Failed to send reminder");
  }
}
