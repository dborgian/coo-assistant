import type { CommandContext, Context } from "grammy";
import { desc, eq, inArray, and, lt, sql } from "drizzle-orm";
import { agent } from "../core/agent.js";
import { db } from "../models/database.js";
import { clients, dailyReports, employees, messageLogs, tasks } from "../models/schema.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { getTodayEvents } from "../services/calendar-sync.js";
import { getUnreadImportantEmails } from "../services/email-manager.js";
import { getNotionWorkspaceSummary, isNotionConfigured } from "../services/notion-sync.js";
import { generateDailyReportPdf, generateEmployeeReportPdf, generateWeeklyReportPdf } from "../services/pdf-generator.js";
import { uploadFileToDrive, listDriveFiles, searchDriveFiles } from "../services/drive-manager.js";
import { buildDashboardMessage } from "./callbacks.js";
import { sendSlackMessage } from "./slack-monitor.js";
import { InputFile } from "grammy";
import {
  getMonitoredSlackChannels,
  addMonitoredSlackChannel,
  removeMonitoredSlackChannel,
} from "./slack-monitor.js";

export async function startCommand(ctx: CommandContext<Context>): Promise<void> {
  await ctx.reply(
    "<b>COO Assistant Online</b>\n\n" +
      "I'm your AI Chief Operating Officer. I monitor communications, " +
      "track tasks, and keep operations running smoothly.\n\n" +
      "Commands:\n" +
      "/dashboard \u2014 Interactive dashboard\n" +
      "/status \u2014 Operations overview\n" +
      "/report \u2014 Generate operations report\n" +
      "/report_pdf \u2014 PDF report (add 'weekly' for weekly)\n" +
      "/employee_report \u2014 Employee activity report (PDF)\n" +
      "/drive \u2014 COO Drive files\n" +
      "/reports \u2014 View report history\n" +
      "/tasks \u2014 View active tasks\n" +
      "/notion \u2014 Notion workspace summary\n" +
      "/slack_report \u2014 Slack digest (last 24h)\n" +
      "/slack_summary \u2014 AI summary of Slack conversations\n" +
      "/remind \u2014 Set a reminder\n" +
      "/add_employee \u2014 Add team member\n" +
      "/add_client \u2014 Add client\n" +
      "/monitor \u2014 Configure Telegram chat monitoring\n" +
      "/slack \u2014 Configure Slack channel monitoring\n" +
      "/help \u2014 Full help\n\n" +
      "Or just send me any message and I'll help.",
    { parse_mode: "HTML" },
  );
}

export async function helpCommand(ctx: CommandContext<Context>): Promise<void> {
  await ctx.reply(
    "<b>COO Assistant \u2014 Commands</b>\n\n" +
      "<b>/dashboard</b> \u2014 Interactive dashboard with buttons\n" +
      "<b>/status</b> \u2014 Quick ops overview (tasks, messages, upcoming)\n" +
      "<b>/report</b> \u2014 Full daily operations report\n" +
      "<b>/reports</b> \u2014 Report history (add date for specific: /reports 2026-03-24)\n" +
      "<b>/tasks</b> \u2014 List active tasks (add 'overdue' for overdue only)\n" +
      "<b>/slack_report</b> \u2014 Slack digest organized by channel (last 24h)\n" +
      "<b>/slack_summary</b> \u2014 AI-generated summary of Slack conversations\n" +
      "<b>/remind [person] [task] [time]</b> \u2014 Set reminder\n" +
      "  Example: /remind John Submit report tomorrow 9am\n" +
      "<b>/add_employee [name] [email] [role]</b> \u2014 Add team member\n" +
      "<b>/add_client [name] [company] [email]</b> \u2014 Add client\n" +
      "<b>/monitor add [chat_id]</b> \u2014 Add Telegram chat to monitor\n" +
      "<b>/monitor list</b> \u2014 Show monitored Telegram chats\n" +
      "<b>/notion</b> \u2014 Notion workspace summary (tasks, projects)\n" +
      "<b>/slack add [channel_id]</b> \u2014 Add Slack channel to monitor\n" +
      "<b>/slack list</b> \u2014 Show monitored Slack channels\n" +
      "<b>/slack remove [channel_id]</b> \u2014 Stop monitoring channel\n\n" +
      "Any other message \u2192 I'll answer as your COO assistant.",
    { parse_mode: "HTML" },
  );
}

export async function statusCommand(ctx: CommandContext<Context>): Promise<void> {
  const now = new Date();

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

  const [msgRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(messageLogs)
    .where(and(eq(messageLogs.needsReply, true), eq(messageLogs.replied, false)));
  const unreadMsgs = msgRow?.count ?? 0;

  const [empRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(employees)
    .where(eq(employees.isActive, true));
  const employeeCount = empRow?.count ?? 0;

  const [cliRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(clients)
    .where(eq(clients.isActive, true));
  const clientCount = cliRow?.count ?? 0;

  let statusText =
    `<b>Operations Status</b>\n\n` +
    `<b>Tasks:</b> ${taskCount} active`;
  if (overdueCount) statusText += ` (${overdueCount} overdue)`;
  statusText +=
    `\n<b>Messages needing reply:</b> ${unreadMsgs}` +
    `\n<b>Team:</b> ${employeeCount} members` +
    `\n<b>Clients:</b> ${clientCount} active`;

  await ctx.reply(statusText, { parse_mode: "HTML" });
}

export async function reportCommand(ctx: CommandContext<Context>): Promise<void> {
  await ctx.reply("Generating operations report...");

  const activeTasks = await db
    .select()
    .from(tasks)
    .where(inArray(tasks.status, ["pending", "in_progress"]));

  const pendingMessages = await db
    .select()
    .from(messageLogs)
    .where(and(eq(messageLogs.needsReply, true), eq(messageLogs.replied, false)));

  const [calendarEvents, importantEmails] = await Promise.all([
    getTodayEvents(),
    getUnreadImportantEmails(5),
  ]);

  const today = new Date().toISOString().split("T")[0];

  const slackMsgs = await db
    .select()
    .from(messageLogs)
    .where(and(
      sql`${messageLogs.receivedAt}::date = ${today}`,
      eq(messageLogs.source, "slack"),
    ));

  const byChannel = new Map<string, typeof slackMsgs>();
  for (const m of slackMsgs) {
    const ch = m.chatTitle ?? "unknown";
    if (!byChannel.has(ch)) byChannel.set(ch, []);
    byChannel.get(ch)!.push(m);
  }

  const data = {
    date: today,
    calendar_events: calendarEvents.map((e) => ({
      summary: e.summary, start: e.start, end: e.end, location: e.location,
    })),
    important_emails: importantEmails.map((e) => ({
      from: e.from, subject: e.subject, snippet: e.snippet,
    })),
    tasks: activeTasks.map((t) => ({
      title: t.title, status: t.status, priority: t.priority, due: t.dueDate,
    })),
    pending_messages: pendingMessages.map((m) => ({
      sender: m.senderName, chat: m.chatTitle, urgency: m.urgency, summary: m.content.slice(0, 200),
    })),
    slack_by_channel: Array.from(byChannel, ([channel, msgs]) => ({
      channel,
      message_count: msgs.length,
      messages: msgs
        .sort((a, b) => String(a.receivedAt ?? "").localeCompare(String(b.receivedAt ?? "")))
        .map((m) => ({
          time: m.receivedAt, sender: m.senderName, urgency: m.urgency, content: m.content.slice(0, 200),
        })),
    })),
  };

  const report = await agent.generateDailyReport(data);

  await db.insert(dailyReports).values({
    reportDate: today,
    reportType: "on_demand",
    content: report,
  });

  if (report.length > 4000) {
    for (let i = 0; i < report.length; i += 4000) {
      await ctx.reply(report.slice(i, i + 4000));
    }
  } else {
    await ctx.reply(report);
  }
}

export async function tasksCommand(ctx: CommandContext<Context>): Promise<void> {
  const args = ctx.match?.toString().trim() ?? "";
  const now = new Date();

  let allTasks;
  if (args.includes("overdue")) {
    allTasks = await db
      .select()
      .from(tasks)
      .where(and(inArray(tasks.status, ["pending", "in_progress"]), lt(tasks.dueDate, now)));
  } else {
    allTasks = await db
      .select()
      .from(tasks)
      .where(inArray(tasks.status, ["pending", "in_progress"]));
  }

  if (!allTasks.length) {
    await ctx.reply("No active tasks.");
    return;
  }

  const priorityEmoji: Record<string, string> = {
    urgent: "\uD83D\uDD34", high: "\uD83D\uDFE0", medium: "\uD83D\uDFE1", low: "\uD83D\uDFE2",
  };

  const lines = ["<b>Active Tasks</b>\n"];
  for (const t of allTasks) {
    const emoji = priorityEmoji[t.priority ?? "medium"] ?? "\u26AA";
    const due = t.dueDate
      ? ` (due ${new Date(t.dueDate).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit" })})`
      : "";
    lines.push(`${emoji} [${t.status}] ${t.title}${due}`);
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

export async function remindCommand(ctx: CommandContext<Context>): Promise<void> {
  const args = ctx.match?.toString().trim().split(/\s+/) ?? [];
  if (args.length < 2 || !args[0]) {
    await ctx.reply("Usage: /remind [person] [task description]\nExample: /remind John Submit the Q1 report");
    return;
  }

  const personName = args[0];
  const taskDesc = args.slice(1).join(" ");

  const [employee] = await db
    .select()
    .from(employees)
    .where(sql`${employees.name} ILIKE ${"%" + personName + "%"}`)
    .limit(1);

  await db.insert(tasks).values({
    title: `Reminder: ${taskDesc}`,
    description: `Reminder for ${personName}: ${taskDesc}`,
    status: "pending",
    priority: "high",
    assignedTo: employee?.id ?? null,
    source: "manual",
  });

  let reply = `Reminder set for <b>${personName}</b>: ${taskDesc}`;
  if (employee?.email) {
    reply += `\n(Will also send email to ${employee.email})`;
  }
  await ctx.reply(reply, { parse_mode: "HTML" });
}

export async function addEmployeeCommand(ctx: CommandContext<Context>): Promise<void> {
  const args = ctx.match?.toString().trim().split(/\s+/) ?? [];
  if (!args[0]) {
    await ctx.reply("Usage: /add_employee [name] [email] [role]\nExample: /add_employee John john@company.com Developer");
    return;
  }

  const name = args[0];
  const email = args[1] ?? null;
  const role = args.slice(2).join(" ") || null;

  await db.insert(employees).values({ name, email, role });

  await ctx.reply(`Added employee: <b>${name}</b> (${role ?? "no role"})`, { parse_mode: "HTML" });
}

export async function addClientCommand(ctx: CommandContext<Context>): Promise<void> {
  const args = ctx.match?.toString().trim().split(/\s+/) ?? [];
  if (!args[0]) {
    await ctx.reply("Usage: /add_client [name] [company] [email]\nExample: /add_client Acme AcmeCorp acme@example.com");
    return;
  }

  const name = args[0];
  const company = args[1] ?? null;
  const email = args[2] ?? null;

  await db.insert(clients).values({ name, company, email });

  await ctx.reply(`Added client: <b>${name}</b> (${company ?? "no company"})`, { parse_mode: "HTML" });
}

export async function monitorCommand(ctx: CommandContext<Context>): Promise<void> {
  const args = ctx.match?.toString().trim().split(/\s+/) ?? [];
  if (!args[0]) {
    await ctx.reply("Usage:\n/monitor list \u2014 Show monitored chats\n/monitor add [chat_id] \u2014 Add chat to monitor");
    return;
  }

  if (args[0] === "list") {
    if (config.MONITORED_CHAT_IDS.length) {
      const chats = config.MONITORED_CHAT_IDS.join("\n");
      await ctx.reply(`<b>Monitored chats:</b>\n${chats}`, { parse_mode: "HTML" });
    } else {
      await ctx.reply("No chats being monitored. Use /monitor add [chat_id]");
    }
  } else if (args[0] === "add" && args[1]) {
    const chatId = parseInt(args[1], 10);
    if (!config.MONITORED_CHAT_IDS.includes(chatId)) {
      config.MONITORED_CHAT_IDS.push(chatId);
    }
    await ctx.reply(`Now monitoring chat: ${chatId}`);
  }
}

export async function slackCommand(ctx: CommandContext<Context>): Promise<void> {
  const args = ctx.match?.toString().trim().split(/\s+/) ?? [];
  if (!args[0]) {
    await ctx.reply("Usage:\n/slack list \u2014 Show monitored Slack channels\n/slack add [channel_id] \u2014 Add channel\n/slack remove [channel_id] \u2014 Remove channel");
    return;
  }

  if (args[0] === "list") {
    const channels = getMonitoredSlackChannels();
    if (channels.length) {
      await ctx.reply(`<b>Monitored Slack channels:</b>\n${channels.join("\n")}`, { parse_mode: "HTML" });
    } else {
      await ctx.reply("No Slack channels being monitored. Use /slack add [channel_id]");
    }
  } else if (args[0] === "add" && args[1]) {
    addMonitoredSlackChannel(args[1]);
    await ctx.reply(`Now monitoring Slack channel: ${args[1]}`);
  } else if (args[0] === "remove" && args[1]) {
    removeMonitoredSlackChannel(args[1]);
    await ctx.reply(`Stopped monitoring Slack channel: ${args[1]}`);
  }
}

export async function reportsCommand(ctx: CommandContext<Context>): Promise<void> {
  const args = ctx.match?.toString().trim() ?? "";

  if (args) {
    const [report] = await db
      .select()
      .from(dailyReports)
      .where(eq(dailyReports.reportDate, args))
      .orderBy(desc(dailyReports.createdAt))
      .limit(1);

    if (!report) {
      await ctx.reply(`No report found for <b>${args}</b>.`, { parse_mode: "HTML" });
      return;
    }

    const typeIcon = report.reportType === "daily" ? "\uD83D\uDCCA" : "\uD83D\uDCCB";
    const header = `${typeIcon} Report ${report.reportDate} (${report.reportType})\n\n`;
    const full = header + report.content;

    if (full.length > 4000) {
      for (let i = 0; i < full.length; i += 4000) {
        await ctx.reply(full.slice(i, i + 4000));
      }
    } else {
      await ctx.reply(full);
    }
    return;
  }

  const reports = await db
    .select()
    .from(dailyReports)
    .orderBy(desc(dailyReports.createdAt))
    .limit(10);

  if (!reports.length) {
    await ctx.reply("No reports yet. Use /report to generate one.");
    return;
  }

  const lines = ["\uD83D\uDCCB <b>Report History</b>\n"];
  for (const r of reports) {
    const typeIcon = r.reportType === "daily" ? "\uD83D\uDCCA" : "\uD83D\uDCCB";
    const preview = r.content
      .replace(/<[^>]+>/g, "")
      .replace(/[#*_~`\-|>]/g, "")
      .replace(/[<>&]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    const time = r.createdAt ? new Date(r.createdAt).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }) : "";
    lines.push(`${typeIcon} <b>${r.reportDate}</b> ${time} ${r.reportType}\n<i>${preview}...</i>`);
  }
  lines.push("\nUse /reports [YYYY-MM-DD] to view a full report.");

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

export async function slackReportCommand(ctx: CommandContext<Context>): Promise<void> {
  const slackMessages = await db
    .select()
    .from(messageLogs)
    .where(and(
      eq(messageLogs.source, "slack"),
      sql`${messageLogs.receivedAt} > now() - interval '24 hours'`,
    ));

  if (!slackMessages.length) {
    await ctx.reply("No Slack messages in the last 24 hours.");
    return;
  }

  const byChannel = new Map<string, typeof slackMessages>();
  for (const m of slackMessages) {
    const ch = m.chatTitle ?? "unknown";
    if (!byChannel.has(ch)) byChannel.set(ch, []);
    byChannel.get(ch)!.push(m);
  }

  for (const msgs of byChannel.values()) {
    msgs.sort((a, b) => String(a.receivedAt ?? "").localeCompare(String(b.receivedAt ?? "")));
  }

  const urgencyIcon: Record<string, string> = {
    critical: "\uD83D\uDD34", high: "\uD83D\uDFE0", normal: "\uD83D\uDFE1", low: "\uD83D\uDFE2",
  };

  const today = new Date().toLocaleDateString("it-IT");
  const lines = [`\uD83D\uDCCA <b>Slack Report \u2014 ${today}</b>\n`];

  for (const [channel, msgs] of byChannel) {
    lines.push(`\n<b>${channel}</b> (${msgs.length} messaggi)`);
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      const time = m.receivedAt ? new Date(m.receivedAt).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }) : "";
      const icon = urgencyIcon[m.urgency ?? "normal"] ?? "\u26AA";
      const connector = i === msgs.length - 1 ? "\u2514" : "\u251C";
      const preview = m.content.slice(0, 150);
      lines.push(`${connector} ${time} ${icon} <b>${m.senderName ?? "Unknown"}</b>: ${preview}`);
    }
  }

  lines.push(`\n<i>Total: ${slackMessages.length} messages across ${byChannel.size} channels</i>`);

  const text = lines.join("\n");
  if (text.length > 4000) {
    for (let i = 0; i < text.length; i += 4000) {
      await ctx.reply(text.slice(i, i + 4000), { parse_mode: "HTML" });
    }
  } else {
    await ctx.reply(text, { parse_mode: "HTML" });
  }
}

export async function slackSummaryCommand(ctx: CommandContext<Context>): Promise<void> {
  const slackMessages = await db
    .select()
    .from(messageLogs)
    .where(and(
      eq(messageLogs.source, "slack"),
      sql`${messageLogs.receivedAt} > now() - interval '24 hours'`,
    ));

  if (!slackMessages.length) {
    await ctx.reply("No Slack messages in the last 24 hours to summarize.");
    return;
  }

  await ctx.reply("Analyzing Slack conversations...");

  const byChannel = new Map<string, typeof slackMessages>();
  for (const m of slackMessages) {
    const ch = m.chatTitle ?? "unknown";
    if (!byChannel.has(ch)) byChannel.set(ch, []);
    byChannel.get(ch)!.push(m);
  }

  const channelData = Array.from(byChannel, ([channel, msgs]) => ({
    channel,
    message_count: msgs.length,
    conversation: msgs
      .sort((a, b) => String(a.receivedAt ?? "").localeCompare(String(b.receivedAt ?? "")))
      .map((m) => ({ time: m.receivedAt, sender: m.senderName, urgency: m.urgency, text: m.content })),
  }));

  const summary = await agent.think(
    `Summarize the following Slack conversations from the last 24 hours.
For each channel, provide:
- A brief summary of what was discussed
- Key decisions or action items
- Any urgent matters that need attention
- Who participated

Be concise but thorough. Use bullet points. Format for Telegram (no HTML, no markdown).`,
    { slack_channels: channelData, total_messages: slackMessages.length },
  );

  if (summary.length > 4000) {
    for (let i = 0; i < summary.length; i += 4000) {
      await ctx.reply(summary.slice(i, i + 4000));
    }
  } else {
    await ctx.reply(summary);
  }
}

export async function dashboardCommand(ctx: CommandContext<Context>): Promise<void> {
  const { text, keyboard } = await buildDashboardMessage();
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
}

export async function notionCommand(ctx: CommandContext<Context>): Promise<void> {
  if (!isNotionConfigured()) {
    await ctx.reply("Notion is not configured. Set NOTION_API_KEY in .env to enable.");
    return;
  }

  await ctx.reply("Fetching Notion workspace...");

  const data = await getNotionWorkspaceSummary();
  const lines = ["\uD83D\uDCDD <b>Notion Workspace</b>\n"];

  if (data.tasks.length) {
    const overdue = data.tasks.filter((t) => t.isOverdue);
    lines.push(`<b>Tasks</b> (${data.tasks.length} total${overdue.length ? `, ${overdue.length} overdue` : ""})`);

    const byStatus = new Map<string, number>();
    for (const t of data.tasks) {
      const s = t.status || "No Status";
      byStatus.set(s, (byStatus.get(s) ?? 0) + 1);
    }
    for (const [status, count] of byStatus) {
      lines.push(`  ${status}: ${count}`);
    }

    if (overdue.length) {
      lines.push(`\n\u26A0\uFE0F <b>Overdue:</b>`);
      for (const t of overdue) {
        const due = t.dueDate ? new Date(t.dueDate).toLocaleDateString("it-IT") : "";
        lines.push(`  - ${t.title} (${t.assignee ?? "unassigned"}) due ${due}`);
      }
    }
  } else {
    lines.push("No tasks found in Notion.");
  }

  if (data.projects.length) {
    lines.push(`\n<b>Projects</b> (${data.projects.length})`);
    for (const p of data.projects) {
      lines.push(`  - ${p.name}${p.status ? ` [${p.status}]` : ""}${p.owner ? ` \u2014 ${p.owner}` : ""}`);
    }
  }

  const text = lines.join("\n");
  if (text.length > 4000) {
    for (let i = 0; i < text.length; i += 4000) {
      await ctx.reply(text.slice(i, i + 4000), { parse_mode: "HTML" });
    }
  } else {
    await ctx.reply(text, { parse_mode: "HTML" });
  }
}

export async function reportPdfCommand(ctx: CommandContext<Context>): Promise<void> {
  const args = ctx.match?.toString().trim() ?? "";

  if (args.includes("weekly") || args.includes("settimana")) {
    await ctx.reply("Generating weekly PDF report...");
    const now = new Date();
    const dayOfWeek = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
    monday.setHours(0, 0, 0, 0);

    const pdf = await generateWeeklyReportPdf(monday, now);
    const fileName = `weekly-report-${monday.toISOString().split("T")[0]}.pdf`;

    // Upload to Drive
    const driveFile = await uploadFileToDrive(fileName, pdf, "application/pdf", config.DRIVE_DAILY_FOLDER_ID || undefined);

    // Send to Telegram
    await ctx.replyWithDocument(new InputFile(pdf, fileName));

    if (driveFile) {
      await ctx.reply(`Saved to Drive: ${driveFile.webViewLink}`);
    }
    return;
  }

  // Default: daily PDF — always generate fresh with AI
  await ctx.reply("Generating daily PDF report...");
  const today = new Date().toISOString().split("T")[0];

  // Fetch live data
  const [activeTasks, doneTasks, allMsgs] = await Promise.all([
    db.select().from(tasks).where(inArray(tasks.status, ["pending", "in_progress"])),
    db.select().from(tasks).where(eq(tasks.status, "done")),
    db.select().from(messageLogs).where(sql`${messageLogs.receivedAt}::date = ${today}`),
  ]);
  const overdueTasks = activeTasks.filter((t) => t.dueDate && new Date(t.dueDate) < new Date());
  const [calEvts, emails] = await Promise.all([
    getTodayEvents().catch(() => []),
    getUnreadImportantEmails(5).catch(() => []),
  ]);
  const slackMsgs = allMsgs.filter((m) => m.source === "slack");
  const notionData = await (await import("../services/notion-sync.js")).getNotionWorkspaceSummary().catch(() => null);

  // Generate AI narrative
  const narrative = await agent.generateDailyReport({
    date: today,
    calendar_events: calEvts.map((e) => ({ summary: e.summary, start: e.start, end: e.end, location: e.location })),
    important_emails: emails.map((e) => ({ from: e.from, subject: e.subject, snippet: e.snippet })),
    tasks: activeTasks.map((t) => ({ title: t.title, status: t.status, priority: t.priority, due: t.dueDate })),
    pending_messages: allMsgs.filter((m) => m.needsReply && !m.replied).map((m) => ({ sender: m.senderName, chat: m.chatTitle, urgency: m.urgency })),
    slack_messages: slackMsgs.length,
  });

  await db.insert(dailyReports).values({ reportDate: today, reportType: "on_demand", content: narrative });

  // Message sources for chart
  const srcCount = new Map<string, number>();
  for (const m of allMsgs) srcCount.set(m.source, (srcCount.get(m.source) ?? 0) + 1);
  const srcColors: Record<string, string> = { slack: "#611f69", telegram: "#0088cc", gmail: "#ea4335" };

  const pdf = await generateDailyReportPdf({
    narrative,
    date: today,
    taskCount: activeTasks.length,
    overdueCount: overdueTasks.length,
    doneCount: doneTasks.length,
    slackMsgCount: slackMsgs.length,
    emailCount: emails.length,
    calendarCount: calEvts.length,
    notionTaskCount: notionData?.tasks.length ?? 0,
    taskList: activeTasks.map((t) => ({ title: t.title, status: t.status, priority: t.priority, due: t.dueDate })),
    msgBySource: Array.from(srcCount, ([s, v]) => ({ label: s, value: v, color: srcColors[s] ?? "#888888" })),
  });
  const fileName = `daily-report-${today}.pdf`;

  const driveFile = await uploadFileToDrive(fileName, pdf, "application/pdf", config.DRIVE_DAILY_FOLDER_ID || undefined);
  await ctx.replyWithDocument(new InputFile(pdf, fileName));

  if (driveFile) {
    await ctx.reply(`Saved to Drive: ${driveFile.webViewLink}`);
  }
}

export async function employeeReportCommand(ctx: CommandContext<Context>): Promise<void> {
  const name = ctx.match?.toString().trim() ?? "";
  if (!name) {
    await ctx.reply("Usage: /employee_report [name]\nExample: /employee_report Damiano");
    return;
  }

  await ctx.reply(`Generating report for ${name}...`);

  const now = new Date();
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);

  const pdf = await generateEmployeeReportPdf(name, weekAgo, now);
  const fileName = `employee-${name.toLowerCase()}-${now.toISOString().split("T")[0]}.pdf`;

  const driveFile = await uploadFileToDrive(fileName, pdf, "application/pdf", config.DRIVE_EMPLOYEE_FOLDER_ID || undefined);
  await ctx.replyWithDocument(new InputFile(pdf, fileName));

  if (driveFile) {
    await ctx.reply(`Saved to Drive: ${driveFile.webViewLink}`);
  }
}

export async function driveCommand(ctx: CommandContext<Context>): Promise<void> {
  const args = ctx.match?.toString().trim() ?? "";

  if (args.startsWith("search ")) {
    const query = args.slice(7).trim();
    const files = await searchDriveFiles(query);
    if (!files.length) {
      await ctx.reply(`No files found for "${query}".`);
      return;
    }
    const lines = [`<b>Drive Search: "${query}"</b>\n`];
    for (const f of files) {
      const date = f.createdTime ? new Date(f.createdTime).toLocaleDateString("it-IT") : "";
      lines.push(`\uD83D\uDCC4 <a href="${f.webViewLink}">${f.name}</a> (${date})`);
    }
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    return;
  }

  const files = await listDriveFiles(10);
  if (!files.length) {
    await ctx.reply("No files in COO Drive folder. Generate a report with /report_pdf first.");
    return;
  }

  const lines = ["\uD83D\uDCC1 <b>COO Drive Files</b>\n"];
  for (const f of files) {
    const date = f.createdTime ? new Date(f.createdTime).toLocaleDateString("it-IT") : "";
    lines.push(`\uD83D\uDCC4 <a href="${f.webViewLink}">${f.name}</a> (${date})`);
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
}

export async function askCommand(ctx: Context): Promise<void> {
  const query = ctx.message?.text;
  if (!query) return;

  logger.info({ query: query.slice(0, 100) }, "Owner query received");

  const response = await agent.answerQuery(query);

  if (response.length > 4000) {
    for (let i = 0; i < response.length; i += 4000) {
      await ctx.reply(response.slice(i, i + 4000));
    }
  } else {
    await ctx.reply(response);
  }
}
