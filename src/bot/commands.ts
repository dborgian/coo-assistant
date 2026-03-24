import type { CommandContext, Context } from "grammy";
import { eq, inArray, and, lt, sql } from "drizzle-orm";
import { agent } from "../core/agent.js";
import { db } from "../models/database.js";
import { clients, employees, messageLogs, tasks } from "../models/schema.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { getTodayEvents } from "../services/calendar-sync.js";
import { getUnreadImportantEmails } from "../services/email-manager.js";
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
      "/status — Operations overview\n" +
      "/report — Generate operations report\n" +
      "/tasks — View active tasks\n" +
      "/remind — Set a reminder\n" +
      "/add_employee — Add team member\n" +
      "/add_client — Add client\n" +
      "/monitor — Configure Telegram chat monitoring\n" +
      "/slack — Configure Slack channel monitoring\n" +
      "/help — Full help\n\n" +
      "Or just send me any message and I'll help.",
    { parse_mode: "HTML" },
  );
}

export async function helpCommand(ctx: CommandContext<Context>): Promise<void> {
  await ctx.reply(
    "<b>COO Assistant — Commands</b>\n\n" +
      "<b>/status</b> — Quick ops overview (tasks, messages, upcoming)\n" +
      "<b>/report</b> — Full daily operations report\n" +
      "<b>/tasks</b> — List active tasks (add 'overdue' for overdue only)\n" +
      "<b>/remind [person] [task] [time]</b> — Set reminder\n" +
      "  Example: /remind John Submit report tomorrow 9am\n" +
      "<b>/add_employee [name] [email] [role]</b> — Add team member\n" +
      "<b>/add_client [name] [company] [email]</b> — Add client\n" +
      "<b>/monitor add [chat_id]</b> — Add Telegram chat to monitor\n" +
      "<b>/monitor list</b> — Show monitored Telegram chats\n" +
      "<b>/slack add [channel_id]</b> — Add Slack channel to monitor\n" +
      "<b>/slack list</b> — Show monitored Slack channels\n" +
      "<b>/slack remove [channel_id]</b> — Stop monitoring channel\n\n" +
      "Any other message → I'll answer as your COO assistant.",
    { parse_mode: "HTML" },
  );
}

export async function statusCommand(ctx: CommandContext<Context>): Promise<void> {
  const now = new Date().toISOString();

  const taskCount = db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(inArray(tasks.status, ["pending", "in_progress"]))
    .get()!.count;

  const overdueCount = db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(
      and(
        inArray(tasks.status, ["pending", "in_progress"]),
        lt(tasks.dueDate, now),
      ),
    )
    .get()!.count;

  const unreadMsgs = db
    .select({ count: sql<number>`count(*)` })
    .from(messageLogs)
    .where(
      and(eq(messageLogs.needsReply, true), eq(messageLogs.replied, false)),
    )
    .get()!.count;

  const employeeCount = db
    .select({ count: sql<number>`count(*)` })
    .from(employees)
    .where(eq(employees.isActive, true))
    .get()!.count;

  const clientCount = db
    .select({ count: sql<number>`count(*)` })
    .from(clients)
    .where(eq(clients.isActive, true))
    .get()!.count;

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

  const activeTasks = db
    .select()
    .from(tasks)
    .where(inArray(tasks.status, ["pending", "in_progress"]))
    .all();

  const pendingMessages = db
    .select()
    .from(messageLogs)
    .where(
      and(eq(messageLogs.needsReply, true), eq(messageLogs.replied, false)),
    )
    .all();

  // Fetch calendar events and emails
  const [calendarEvents, importantEmails] = await Promise.all([
    getTodayEvents(),
    getUnreadImportantEmails(5),
  ]);

  const data = {
    date: new Date().toISOString().split("T")[0],
    calendar_events: calendarEvents.map((e) => ({
      summary: e.summary,
      start: e.start,
      end: e.end,
      location: e.location,
    })),
    important_emails: importantEmails.map((e) => ({
      from: e.from,
      subject: e.subject,
      snippet: e.snippet,
    })),
    tasks: activeTasks.map((t) => ({
      title: t.title,
      status: t.status,
      priority: t.priority,
      due: t.dueDate,
    })),
    pending_messages: pendingMessages.map((m) => ({
      sender: m.senderName,
      chat: m.chatTitle,
      urgency: m.urgency,
      summary: m.content.slice(0, 200),
    })),
  };

  const report = await agent.generateDailyReport(data);

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
  const now = new Date().toISOString();

  let allTasks;
  if (args.includes("overdue")) {
    allTasks = db
      .select()
      .from(tasks)
      .where(
        and(
          inArray(tasks.status, ["pending", "in_progress"]),
          lt(tasks.dueDate, now),
        ),
      )
      .all();
  } else {
    allTasks = db
      .select()
      .from(tasks)
      .where(inArray(tasks.status, ["pending", "in_progress"]))
      .all();
  }

  if (!allTasks.length) {
    await ctx.reply("No active tasks.");
    return;
  }

  const priorityEmoji: Record<string, string> = {
    urgent: "🔴",
    high: "🟠",
    medium: "🟡",
    low: "🟢",
  };

  const lines = ["<b>Active Tasks</b>\n"];
  for (const t of allTasks) {
    const emoji = priorityEmoji[t.priority ?? "medium"] ?? "⚪";
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
    await ctx.reply(
      "Usage: /remind [person] [task description]\nExample: /remind John Submit the Q1 report",
    );
    return;
  }

  const personName = args[0];
  const taskDesc = args.slice(1).join(" ");

  const employee = db
    .select()
    .from(employees)
    .where(sql`${employees.name} LIKE ${"%" + personName + "%"}`)
    .get();

  db.insert(tasks)
    .values({
      title: `Reminder: ${taskDesc}`,
      description: `Reminder for ${personName}: ${taskDesc}`,
      status: "pending",
      priority: "high",
      assignedTo: employee?.id ?? null,
      source: "manual",
    })
    .run();

  let reply = `Reminder set for <b>${personName}</b>: ${taskDesc}`;
  if (employee?.email) {
    reply += `\n(Will also send email to ${employee.email})`;
  }
  await ctx.reply(reply, { parse_mode: "HTML" });
}

export async function addEmployeeCommand(ctx: CommandContext<Context>): Promise<void> {
  const args = ctx.match?.toString().trim().split(/\s+/) ?? [];
  if (!args[0]) {
    await ctx.reply(
      "Usage: /add_employee [name] [email] [role]\n" +
        "Example: /add_employee John john@company.com Developer",
    );
    return;
  }

  const name = args[0];
  const email = args[1] ?? null;
  const role = args.slice(2).join(" ") || null;

  db.insert(employees).values({ name, email, role }).run();

  await ctx.reply(
    `Added employee: <b>${name}</b> (${role ?? "no role"})`,
    { parse_mode: "HTML" },
  );
}

export async function addClientCommand(ctx: CommandContext<Context>): Promise<void> {
  const args = ctx.match?.toString().trim().split(/\s+/) ?? [];
  if (!args[0]) {
    await ctx.reply(
      "Usage: /add_client [name] [company] [email]\n" +
        "Example: /add_client Acme AcmeCorp acme@example.com",
    );
    return;
  }

  const name = args[0];
  const company = args[1] ?? null;
  const email = args[2] ?? null;

  db.insert(clients).values({ name, company, email }).run();

  await ctx.reply(
    `Added client: <b>${name}</b> (${company ?? "no company"})`,
    { parse_mode: "HTML" },
  );
}

export async function monitorCommand(ctx: CommandContext<Context>): Promise<void> {
  const args = ctx.match?.toString().trim().split(/\s+/) ?? [];
  if (!args[0]) {
    await ctx.reply(
      "Usage:\n/monitor list — Show monitored chats\n/monitor add [chat_id] — Add chat to monitor",
    );
    return;
  }

  if (args[0] === "list") {
    if (config.MONITORED_CHAT_IDS.length) {
      const chats = config.MONITORED_CHAT_IDS.join("\n");
      await ctx.reply(`<b>Monitored chats:</b>\n${chats}`, {
        parse_mode: "HTML",
      });
    } else {
      await ctx.reply(
        "No chats being monitored. Use /monitor add [chat_id]",
      );
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
    await ctx.reply(
      "Usage:\n/slack list — Show monitored Slack channels\n/slack add [channel_id] — Add channel\n/slack remove [channel_id] — Remove channel",
    );
    return;
  }

  if (args[0] === "list") {
    const channels = getMonitoredSlackChannels();
    if (channels.length) {
      await ctx.reply(
        `<b>Monitored Slack channels:</b>\n${channels.join("\n")}`,
        { parse_mode: "HTML" },
      );
    } else {
      await ctx.reply(
        "No Slack channels being monitored. Use /slack add [channel_id]",
      );
    }
  } else if (args[0] === "add" && args[1]) {
    addMonitoredSlackChannel(args[1]);
    await ctx.reply(`Now monitoring Slack channel: ${args[1]}`);
  } else if (args[0] === "remove" && args[1]) {
    removeMonitoredSlackChannel(args[1]);
    await ctx.reply(`Stopped monitoring Slack channel: ${args[1]}`);
  }
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
