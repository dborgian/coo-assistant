import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { desc, eq, inArray, and, lt, sql } from "drizzle-orm";
import { db } from "../models/database.js";
import { tasks, messageLogs, dailyReports } from "../models/schema.js";
import { agent } from "../core/agent.js";
import { logger } from "../utils/logger.js";
import { getTodayEvents } from "../services/calendar-sync.js";
import { getUnreadImportantEmails } from "../services/email-manager.js";
import { getNotionWorkspaceSummary, isNotionConfigured } from "../services/notion-sync.js";
import { listDriveFiles } from "../services/drive-manager.js";

const MAX_MSG_LEN = 4096;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(text: string, hint: string, max = MAX_MSG_LEN - 200): string {
  if (text.length <= max) return text;
  const cutIdx = text.lastIndexOf("\n", max);
  return text.slice(0, cutIdx > 0 ? cutIdx : max) + `\n\n... Use ${hint} for full view.`;
}

function backButton(): InlineKeyboard {
  return new InlineKeyboard().text("\u2190 Dashboard", "dash:back");
}

export async function buildDashboardMessage(): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const now = new Date();
  const today = now.toISOString().split("T")[0];
  const dateStr = now.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric" });

  const [taskRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(inArray(tasks.status, ["pending", "in_progress"]));
  const taskCount = taskRow?.count ?? 0;

  const [overdueRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(and(inArray(tasks.status, ["pending", "in_progress"]), lt(tasks.dueDate, now)));
  const overdueCount = overdueRow?.count ?? 0;

  const [slackRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(messageLogs)
    .where(and(sql`${messageLogs.receivedAt}::date = ${today}`, eq(messageLogs.source, "slack")));
  const slackToday = slackRow?.count ?? 0;

  const [calendarEvents, emails, notionData] = await Promise.all([
    getTodayEvents().catch(() => []),
    getUnreadImportantEmails(5).catch(() => []),
    isNotionConfigured() ? getNotionWorkspaceSummary().catch(() => null) : Promise.resolve(null),
  ]);

  let text =
    `<b>COO Dashboard</b> \u2014 ${dateStr}\n` +
    `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n` +
    `\uD83D\uDCCB Tasks: ${taskCount} active` + (overdueCount ? ` (${overdueCount} overdue)` : "") + `\n` +
    `\uD83D\uDCAC Slack: ${slackToday} messages today\n` +
    `\uD83D\uDCE7 Email: ${emails.length} unread important\n` +
    `\uD83D\uDCC5 Calendar: ${calendarEvents.length} events`;

  if (notionData) {
    const notionOverdue = notionData.tasks.filter((t) => t.isOverdue).length;
    text += `\n\uD83D\uDCDD Notion: ${notionData.tasks.length} tasks` + (notionOverdue ? ` (${notionOverdue} overdue)` : "");
  }

  text += `\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`;

  const keyboard = new InlineKeyboard()
    .text("\uD83D\uDCCB Tasks", "dash:tasks").text("\uD83D\uDCAC Slack", "dash:slack").text("\uD83D\uDCE7 Email", "dash:email").row()
    .text("\uD83D\uDCC5 Calendar", "dash:calendar").text("\uD83D\uDCDD Notion", "dash:notion").row()
    .text("\uD83D\uDCC1 Drive", "dash:drive").text("\uD83D\uDCCA Report", "dash:report").text("\uD83D\uDCDC History", "dash:history");

  return { text, keyboard };
}

export function registerCallbacks(bot: Bot): void {
  bot.callbackQuery("dash:back", handleBack);
  bot.callbackQuery("dash:tasks", handleTasks);
  bot.callbackQuery("dash:slack", handleSlack);
  bot.callbackQuery("dash:email", handleEmail);
  bot.callbackQuery("dash:calendar", handleCalendar);
  bot.callbackQuery("dash:notion", handleNotion);
  bot.callbackQuery("dash:drive", handleDrive);
  bot.callbackQuery("dash:report", handleReport);
  bot.callbackQuery("dash:history", handleHistory);
}

async function handleBack(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery();
  try {
    const { text, keyboard } = await buildDashboardMessage();
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
  } catch (err) {
    logger.error({ err }, "Dashboard back failed");
  }
}

async function handleTasks(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery();
  try {
    const now = new Date();
    const allTasks = await db
      .select()
      .from(tasks)
      .where(inArray(tasks.status, ["pending", "in_progress"]));

    if (!allTasks.length) {
      await ctx.editMessageText("\uD83D\uDCCB <b>Tasks</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\nNo active tasks.", { parse_mode: "HTML", reply_markup: backButton() });
      return;
    }

    const priorityEmoji: Record<string, string> = { urgent: "\uD83D\uDD34", high: "\uD83D\uDFE0", medium: "\uD83D\uDFE1", low: "\uD83D\uDFE2" };
    const lines = ["\uD83D\uDCCB <b>Active Tasks</b>", "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501"];
    for (const t of allTasks) {
      const emoji = priorityEmoji[t.priority ?? "medium"] ?? "\u26AA";
      const due = t.dueDate
        ? ` (due ${new Date(t.dueDate).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit" })})`
        : "";
      const overdue = t.dueDate && new Date(t.dueDate) < now ? " \u26A0\uFE0F" : "";
      lines.push(`${emoji} [${t.status}] ${t.title}${due}${overdue}`);
    }

    const text = truncate(lines.join("\n"), "/tasks");
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: backButton() });
  } catch (err) {
    logger.error({ err }, "Dashboard tasks failed");
  }
}

async function handleSlack(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery();
  try {
    const slackMessages = await db
      .select()
      .from(messageLogs)
      .where(and(
        eq(messageLogs.source, "slack"),
        sql`${messageLogs.receivedAt} > now() - interval '24 hours'`,
      ));

    if (!slackMessages.length) {
      await ctx.editMessageText("\uD83D\uDCAC <b>Slack</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\nNo Slack messages in the last 24h.", { parse_mode: "HTML", reply_markup: backButton() });
      return;
    }

    const byChannel = new Map<string, typeof slackMessages>();
    for (const m of slackMessages) {
      const ch = m.chatTitle ?? "unknown";
      if (!byChannel.has(ch)) byChannel.set(ch, []);
      byChannel.get(ch)!.push(m);
    }

    const lines = ["\uD83D\uDCAC <b>Slack \u2014 Last 24h</b>", "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501"];
    for (const [channel, msgs] of byChannel) {
      msgs.sort((a, b) => String(a.receivedAt ?? "").localeCompare(String(b.receivedAt ?? "")));
      lines.push(`\n<b>${channel}</b> (${msgs.length} msgs)`);
      for (const m of msgs.slice(-5)) {
        const time = m.receivedAt ? new Date(m.receivedAt).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }) : "";
        lines.push(`  ${time} <b>${esc(m.senderName ?? "?")}</b>: ${esc(m.content.slice(0, 100))}`);
      }
      if (msgs.length > 5) lines.push(`  <i>... +${msgs.length - 5} more</i>`);
    }

    const text = truncate(lines.join("\n"), "/slack_report");
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: backButton() });
  } catch (err) {
    logger.error({ err }, "Dashboard slack failed");
  }
}

async function handleEmail(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery();
  try {
    const emails = await getUnreadImportantEmails(5).catch(() => []);

    if (!emails.length) {
      await ctx.editMessageText("\uD83D\uDCE7 <b>Email</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\nNo unread important emails.", { parse_mode: "HTML", reply_markup: backButton() });
      return;
    }

    const lines = ["\uD83D\uDCE7 <b>Unread Important Emails</b>", "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501"];
    for (const e of emails) {
      lines.push(`\n<b>${esc(e.subject)}</b>`);
      lines.push(`From: ${esc(e.from)}`);
      if (e.snippet) lines.push(`<i>${esc(e.snippet.slice(0, 120))}</i>`);
    }

    const text = truncate(lines.join("\n"), "/help");
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: backButton() });
  } catch (err) {
    logger.error({ err }, "Dashboard email failed");
  }
}

async function handleCalendar(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery();
  try {
    const events = await getTodayEvents().catch(() => []);

    if (!events.length) {
      await ctx.editMessageText("\uD83D\uDCC5 <b>Calendar</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\nNo events today.", { parse_mode: "HTML", reply_markup: backButton() });
      return;
    }

    const lines = ["\uD83D\uDCC5 <b>Today's Calendar</b>", "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501"];
    for (const e of events) {
      const start = e.start ? new Date(e.start).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }) : "";
      const end = e.end ? new Date(e.end).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }) : "";
      lines.push(`\n\uD83D\uDD52 ${start}\u2013${end}`);
      lines.push(`<b>${e.summary}</b>`);
      if (e.location) lines.push(`\uD83D\uDCCD ${e.location}`);
    }

    const text = truncate(lines.join("\n"), "/help");
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: backButton() });
  } catch (err) {
    logger.error({ err }, "Dashboard calendar failed");
  }
}

async function handleNotion(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery();
  try {
    if (!isNotionConfigured()) {
      await ctx.editMessageText(
        "\uD83D\uDCDD <b>Notion \u2014 Not Configured</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\nSet NOTION_API_KEY in .env to enable Notion integration.",
        { parse_mode: "HTML", reply_markup: backButton() },
      );
      return;
    }

    const data = await getNotionWorkspaceSummary();
    const lines = ["\uD83D\uDCDD <b>Notion Workspace</b>", "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501"];

    if (data.tasks.length) {
      const overdue = data.tasks.filter((t) => t.isOverdue);
      lines.push(`\n<b>Tasks</b> (${data.tasks.length} total${overdue.length ? `, ${overdue.length} overdue` : ""})`);

      const byStatus = new Map<string, typeof data.tasks>();
      for (const t of data.tasks) {
        const s = t.status || "No Status";
        if (!byStatus.has(s)) byStatus.set(s, []);
        byStatus.get(s)!.push(t);
      }
      for (const [status, statusTasks] of byStatus) {
        lines.push(`  ${status}: ${statusTasks.length}`);
      }

      if (overdue.length) {
        lines.push(`\n\u26A0\uFE0F <b>Overdue:</b>`);
        for (const t of overdue.slice(0, 5)) {
          const due = t.dueDate ? new Date(t.dueDate).toLocaleDateString("it-IT") : "";
          lines.push(`  - ${t.title} (${t.assignee ?? "unassigned"}) due ${due}`);
        }
      }
    } else {
      lines.push("\nNo tasks found.");
    }

    if (data.projects.length) {
      lines.push(`\n<b>Projects</b> (${data.projects.length})`);
      for (const p of data.projects.slice(0, 10)) {
        lines.push(`  - ${p.name}${p.status ? ` [${p.status}]` : ""}${p.owner ? ` \u2014 ${p.owner}` : ""}`);
      }
    }

    const text = truncate(lines.join("\n"), "/notion");
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: backButton() });
  } catch (err) {
    logger.error({ err }, "Dashboard notion failed");
  }
}

async function handleDrive(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery();
  try {
    const files = await listDriveFiles(10);

    if (!files.length) {
      await ctx.editMessageText(
        "\uD83D\uDCC1 <b>Drive</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\nNo files in COO folder. Use /report_pdf to generate one.",
        { parse_mode: "HTML", reply_markup: backButton() },
      );
      return;
    }

    const lines = ["\uD83D\uDCC1 <b>COO Drive Files</b>", "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501"];
    for (const f of files) {
      const date = f.createdTime ? new Date(f.createdTime).toLocaleDateString("it-IT") : "";
      lines.push(`\uD83D\uDCC4 ${f.name} (${date})`);
    }
    lines.push("\nUse /drive for links.");

    const text = truncate(lines.join("\n"), "/drive");
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: backButton() });
  } catch (err) {
    logger.error({ err }, "Dashboard drive failed");
  }
}

async function handleReport(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery();
  try {
    await ctx.editMessageText("\uD83D\uDCCA <b>Generating report...</b>", { parse_mode: "HTML" });

    const activeTasks = await db.select().from(tasks).where(inArray(tasks.status, ["pending", "in_progress"]));
    const pendingMessages = await db.select().from(messageLogs)
      .where(and(eq(messageLogs.needsReply, true), eq(messageLogs.replied, false)));

    const today = new Date().toISOString().split("T")[0];
    const [calendarEvents, importantEmails, notionData] = await Promise.all([
      getTodayEvents().catch(() => []),
      getUnreadImportantEmails(5).catch(() => []),
      isNotionConfigured() ? getNotionWorkspaceSummary().catch(() => null) : Promise.resolve(null),
    ]);

    const slackMsgs = await db.select().from(messageLogs)
      .where(and(sql`${messageLogs.receivedAt}::date = ${today}`, eq(messageLogs.source, "slack")));

    const byChannel = new Map<string, typeof slackMsgs>();
    for (const m of slackMsgs) {
      const ch = m.chatTitle ?? "unknown";
      if (!byChannel.has(ch)) byChannel.set(ch, []);
      byChannel.get(ch)!.push(m);
    }

    const data: Record<string, unknown> = {
      date: today,
      calendar_events: calendarEvents.map((e) => ({ summary: e.summary, start: e.start, end: e.end, location: e.location })),
      important_emails: importantEmails.map((e) => ({ from: e.from, subject: e.subject, snippet: e.snippet })),
      tasks: activeTasks.map((t) => ({ title: t.title, status: t.status, priority: t.priority, due: t.dueDate })),
      pending_messages: pendingMessages.map((m) => ({ sender: m.senderName, chat: m.chatTitle, urgency: m.urgency, summary: m.content.slice(0, 200) })),
      slack_by_channel: Array.from(byChannel, ([channel, msgs]) => ({
        channel, message_count: msgs.length,
        messages: msgs.sort((a, b) => String(a.receivedAt ?? "").localeCompare(String(b.receivedAt ?? "")))
          .map((m) => ({ time: m.receivedAt, sender: m.senderName, urgency: m.urgency, content: m.content.slice(0, 200) })),
      })),
    };

    if (notionData) {
      data.notion_tasks = notionData.tasks.map((t) => ({ title: t.title, status: t.status, priority: t.priority, assignee: t.assignee, due: t.dueDate, overdue: t.isOverdue }));
      data.notion_projects = notionData.projects.map((p) => ({ name: p.name, status: p.status, owner: p.owner }));
    }

    const report = await agent.generateDailyReport(data);

    await db.insert(dailyReports).values({ reportDate: today, reportType: "on_demand", content: report });

    const text = truncate(report, "/report");
    await ctx.editMessageText(text, { reply_markup: backButton() });
  } catch (err) {
    logger.error({ err }, "Dashboard report failed");
    await ctx.editMessageText("Failed to generate report. Try /report instead.", { reply_markup: backButton() }).catch(() => {});
  }
}

async function handleHistory(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery();
  try {
    const reports = await db
      .select()
      .from(dailyReports)
      .orderBy(desc(dailyReports.createdAt))
      .limit(10);

    if (!reports.length) {
      await ctx.editMessageText("\uD83D\uDCDC <b>History</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\nNo reports yet. Use /report to generate one.", { parse_mode: "HTML", reply_markup: backButton() });
      return;
    }

    const lines = ["\uD83D\uDCDC <b>Report History</b>", "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501"];
    for (const r of reports) {
      const typeIcon = r.reportType === "daily" ? "\uD83D\uDCCA" : "\uD83D\uDCCB";
      const preview = r.content
        .replace(/<[^>]+>/g, "")
        .replace(/[#*_~`\-|>]/g, "")
        .replace(/[<>&]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60);
      const time = r.createdAt ? new Date(r.createdAt).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }) : "";
      lines.push(`${typeIcon} <b>${r.reportDate}</b> ${time} ${r.reportType}\n<i>${preview}...</i>`);
    }
    lines.push("\nUse /reports [YYYY-MM-DD] for a full report.");

    const text = truncate(lines.join("\n"), "/reports");
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: backButton() });
  } catch (err) {
    logger.error({ err }, "Dashboard history failed");
  }
}
