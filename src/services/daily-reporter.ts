import type { Bot } from "grammy";
import { and, eq, inArray, sql } from "drizzle-orm";
import { agent } from "../core/agent.js";
import { config } from "../config.js";
import { db } from "../models/database.js";
import { dailyReports, messageLogs, tasks } from "../models/schema.js";
import { logger } from "../utils/logger.js";

export async function generateAndSendDailyReport(bot: Bot): Promise<void> {
  const today = new Date().toISOString().split("T")[0];
  logger.info({ date: today }, "Generating daily report");

  const activeTasks = db
    .select()
    .from(tasks)
    .where(inArray(tasks.status, ["pending", "in_progress"]))
    .all();

  const now = new Date().toISOString();
  const overdueTasks = activeTasks.filter(
    (t) => t.dueDate && t.dueDate < now,
  );

  const pendingMessages = db
    .select()
    .from(messageLogs)
    .where(
      and(eq(messageLogs.needsReply, true), eq(messageLogs.replied, false)),
    )
    .all();

  const todayMessagesCount = db
    .select({ count: sql<number>`count(*)` })
    .from(messageLogs)
    .where(sql`date(${messageLogs.receivedAt}) = ${today}`)
    .get()!.count;

  const reportData = {
    date: today,
    active_tasks: activeTasks.map((t) => ({
      title: t.title,
      status: t.status,
      priority: t.priority,
      due: t.dueDate,
    })),
    overdue_tasks: overdueTasks.map((t) => ({
      title: t.title,
      priority: t.priority,
      due: t.dueDate,
    })),
    pending_replies: pendingMessages.map((m) => ({
      sender: m.senderName,
      chat: m.chatTitle,
      urgency: m.urgency,
      received: m.receivedAt,
    })),
    messages_today: todayMessagesCount,
    summary: {
      total_active_tasks: activeTasks.length,
      overdue_count: overdueTasks.length,
      pending_replies: pendingMessages.length,
    },
  };

  const reportContent = await agent.generateDailyReport(reportData);

  // Save to DB
  db.insert(dailyReports)
    .values({
      reportDate: today,
      reportType: "daily",
      content: reportContent,
    })
    .run();

  // Send via Telegram
  try {
    if (reportContent.length > 4000) {
      for (let i = 0; i < reportContent.length; i += 4000) {
        await bot.api.sendMessage(
          config.TELEGRAM_OWNER_CHAT_ID,
          reportContent.slice(i, i + 4000),
        );
      }
    } else {
      await bot.api.sendMessage(
        config.TELEGRAM_OWNER_CHAT_ID,
        reportContent,
      );
    }
    logger.info({ date: today }, "Daily report sent");
  } catch (err) {
    logger.error({ err }, "Failed to send daily report");
  }
}
