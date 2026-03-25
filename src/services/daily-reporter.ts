import type { Bot } from "grammy";
import { and, eq, inArray, sql } from "drizzle-orm";
import { agent } from "../core/agent.js";
import { config } from "../config.js";
import { db } from "../models/database.js";
import { dailyReports, messageLogs, tasks } from "../models/schema.js";
import { getTodayEvents } from "./calendar-sync.js";
import { getUnreadImportantEmails } from "./email-manager.js";
import { getNotionWorkspaceSummary, isNotionConfigured } from "./notion-sync.js";
import { logger } from "../utils/logger.js";

export async function generateAndSendDailyReport(bot: Bot): Promise<void> {
  const today = new Date().toISOString().split("T")[0];
  const now = new Date();
  logger.info({ date: today }, "Generating daily report");

  const [activeTasks, pendingMessages] = await Promise.all([
    db.select().from(tasks).where(inArray(tasks.status, ["pending", "in_progress"])),
    db.select().from(messageLogs).where(and(eq(messageLogs.needsReply, true), eq(messageLogs.replied, false))),
  ]);

  const overdueTasks = activeTasks.filter((t) => t.dueDate && new Date(t.dueDate) < now);

  const [todayMsgRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(messageLogs)
    .where(sql`${messageLogs.receivedAt}::date = ${today}`);
  const todayMessagesCount = todayMsgRow?.count ?? 0;

  // Fetch calendar events, emails, and Notion data
  const [calendarEvents, importantEmails, notionData] = await Promise.all([
    getTodayEvents(),
    getUnreadImportantEmails(10),
    isNotionConfigured() ? getNotionWorkspaceSummary().catch((err) => { logger.error({ err }, "Notion fetch failed in report"); return null; }) : Promise.resolve(null),
  ]);

  // Slack messages today
  const slackMsgs = await db
    .select()
    .from(messageLogs)
    .where(and(sql`${messageLogs.receivedAt}::date = ${today}`, eq(messageLogs.source, "slack")));

  const byChannel = new Map<string, typeof slackMsgs>();
  for (const m of slackMsgs) {
    const ch = m.chatTitle ?? "unknown";
    if (!byChannel.has(ch)) byChannel.set(ch, []);
    byChannel.get(ch)!.push(m);
  }

  const reportData = {
    date: today,
    calendar_events: calendarEvents.map((e) => ({
      summary: e.summary, start: e.start, end: e.end, location: e.location,
    })),
    important_emails: importantEmails.map((e) => ({
      from: e.from, subject: e.subject, snippet: e.snippet,
    })),
    active_tasks: activeTasks.map((t) => ({
      title: t.title, status: t.status, priority: t.priority, due: t.dueDate,
    })),
    overdue_tasks: overdueTasks.map((t) => ({
      title: t.title, priority: t.priority, due: t.dueDate,
    })),
    pending_replies: pendingMessages.map((m) => ({
      sender: m.senderName, chat: m.chatTitle, urgency: m.urgency, received: m.receivedAt,
    })),
    messages_today: todayMessagesCount,
    slack_by_channel: Array.from(byChannel, ([channel, msgs]) => ({
      channel,
      message_count: msgs.length,
      messages: msgs
        .sort((a, b) => String(a.receivedAt ?? "").localeCompare(String(b.receivedAt ?? "")))
        .map((m) => ({
          time: m.receivedAt, sender: m.senderName, urgency: m.urgency, content: m.content.slice(0, 200),
        })),
    })),
    notion_tasks: notionData?.tasks.map((t) => ({
      title: t.title, status: t.status, priority: t.priority,
      assignee: t.assignee, due: t.dueDate, overdue: t.isOverdue,
    })) ?? [],
    notion_projects: notionData?.projects.map((p) => ({
      name: p.name, status: p.status, owner: p.owner,
    })) ?? [],
    summary: {
      total_active_tasks: activeTasks.length,
      overdue_count: overdueTasks.length,
      pending_replies: pendingMessages.length,
      calendar_events: calendarEvents.length,
      unread_important_emails: importantEmails.length,
      notion_tasks: notionData?.tasks.length ?? 0,
      notion_overdue: notionData?.tasks.filter((t) => t.isOverdue).length ?? 0,
      slack_messages_today: slackMsgs.length,
    },
  };

  const reportContent = await agent.generateDailyReport(reportData);

  // Save to DB
  await db.insert(dailyReports).values({
    reportDate: today,
    reportType: "daily",
    content: reportContent,
  });

  // Send via Telegram
  try {
    if (reportContent.length > 4000) {
      for (let i = 0; i < reportContent.length; i += 4000) {
        await bot.api.sendMessage(config.TELEGRAM_OWNER_CHAT_ID, reportContent.slice(i, i + 4000));
      }
    } else {
      await bot.api.sendMessage(config.TELEGRAM_OWNER_CHAT_ID, reportContent);
    }
    logger.info({ date: today }, "Daily report sent");
  } catch (err) {
    logger.error({ err }, "Failed to send daily report");
  }
}
