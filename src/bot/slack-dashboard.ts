/**
 * Slack Block Kit interactive dashboard — replaces Telegram inline keyboard callbacks.
 *
 * buildDashboardBlocks() returns Block Kit blocks for /coo-dashboard.
 * registerDashboardActions() registers all button action handlers on the Slack app.
 */
import type { App as SlackApp } from "@slack/bolt";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../models/database.js";
import { dailyReports, messageLogs, tasks } from "../models/schema.js";
import { agent } from "../core/agent.js";
import { getTodayEvents } from "../services/calendar-sync.js";
import { getAuthForEmployee } from "../core/google-auth.js";
import { getUnreadImportantEmails } from "../services/email-manager.js";
import { getNotionWorkspaceSummary, isNotionConfigured } from "../services/notion-sync.js";
import { listDriveFiles } from "../services/drive-manager.js";
import { canAccessSection } from "./permissions.js";
import type { AccessRole } from "./auth-types.js";
import { computeHealthScore } from "../services/health-score.js";
import { logger } from "../utils/logger.js";

const MAX_MSG_LEN = 3000;

function truncate(text: string, max = MAX_MSG_LEN): string {
  if (text.length <= max) return text;
  const cutIdx = text.lastIndexOf("\n", max);
  return text.slice(0, cutIdx > 0 ? cutIdx : max) + "\n\n_... (usa /coo-reports per la vista completa)_";
}

/** Build the main dashboard Block Kit blocks, role-aware. */
export async function buildDashboardBlocks(
  role: AccessRole = "owner",
  employeeId: string | null = null,
): Promise<any[]> {
  const now = new Date();
  const today = now.toISOString().split("T")[0];
  const dateStr = now.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric" });

  if (role === "viewer" && employeeId) {
    const [myTaskRow] = await db.select({ count: sql<number>`count(*)` }).from(tasks)
      .where(and(eq(tasks.assignedTo, employeeId), inArray(tasks.status, ["pending", "in_progress"])));
    const [myOverdueRow] = await db.select({ count: sql<number>`count(*)` }).from(tasks)
      .where(and(eq(tasks.assignedTo, employeeId), inArray(tasks.status, ["pending", "in_progress"]), lt(tasks.dueDate, now)));
    const empAuth = await getAuthForEmployee(employeeId);
    const calendarEvents = empAuth ? await getTodayEvents(empAuth).catch(() => []) : [];
    const calendarLabel = empAuth
      ? `${calendarEvents.length} eventi oggi`
      : `_Collega il tuo Google Calendar con /coo-connect-google_`;

    const overdueText = myOverdueRow?.count ? ` (${myOverdueRow.count} scaduti)` : "";
    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Dashboard* — ${dateStr}\n━━━━━━━━━━━━━━━━━━━━━\n📋 I tuoi task: ${myTaskRow?.count ?? 0} attivi${overdueText}\n📅 Calendario: ${calendarLabel}`,
        },
      },
      {
        type: "actions",
        elements: [
          { type: "button", text: { type: "plain_text", text: "📋 I miei task" }, action_id: "dash:tasks" },
          { type: "button", text: { type: "plain_text", text: "📅 Calendario" }, action_id: "dash:calendar" },
        ],
      },
    ];
  }

  const [taskRow] = await db.select({ count: sql<number>`count(*)` }).from(tasks)
    .where(inArray(tasks.status, ["pending", "in_progress"]));
  const taskCount = taskRow?.count ?? 0;
  const [overdueRow] = await db.select({ count: sql<number>`count(*)` }).from(tasks)
    .where(and(inArray(tasks.status, ["pending", "in_progress"]), lt(tasks.dueDate, now)));
  const overdueCount = overdueRow?.count ?? 0;
  const [slackRow] = await db.select({ count: sql<number>`count(*)` }).from(messageLogs)
    .where(and(sql`${messageLogs.receivedAt}::date = ${today}`, eq(messageLogs.source, "slack")));
  const slackToday = slackRow?.count ?? 0;
  const [calendarEvents, emails, notionData, healthScore] = await Promise.all([
    getTodayEvents().catch(() => []),
    getUnreadImportantEmails(5).catch(() => []),
    isNotionConfigured() ? getNotionWorkspaceSummary().catch(() => null) : Promise.resolve(null),
    computeHealthScore().catch(() => null),
  ]);

  let statusText =
    `*COO Dashboard* — ${dateStr}\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n`;
  if (healthScore) {
    statusText += `${healthScore.emoji} *Health Score: ${healthScore.score}/100* (${healthScore.label})\n`;
  }
  statusText +=
    `📋 Tasks: ${taskCount} attivi` + (overdueCount ? ` (${overdueCount} scaduti)` : "") + `\n` +
    `💬 Slack: ${slackToday} messaggi oggi\n` +
    `📧 Email: ${emails.length} non lette importanti\n` +
    `📅 Calendario: ${calendarEvents.length} eventi`;
  if (notionData) {
    const notionOverdue = notionData.tasks.filter((t) => t.isOverdue).length;
    statusText += `\n📝 Notion: ${notionData.tasks.length} tasks` + (notionOverdue ? ` (${notionOverdue} scaduti)` : "");
  }
  statusText += `\n━━━━━━━━━━━━━━━━━━━━━`;

  const blocks: any[] = [
    { type: "section", text: { type: "mrkdwn", text: statusText } },
    {
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "📋 Tasks" }, action_id: "dash:tasks" },
        { type: "button", text: { type: "plain_text", text: "💬 Slack" }, action_id: "dash:slack" },
        { type: "button", text: { type: "plain_text", text: "📧 Email" }, action_id: "dash:email" },
      ],
    },
    {
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "📅 Calendario" }, action_id: "dash:calendar" },
        { type: "button", text: { type: "plain_text", text: "📝 Notion" }, action_id: "dash:notion" },
      ],
    },
    {
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "📁 Drive" }, action_id: "dash:drive" },
        { type: "button", text: { type: "plain_text", text: "📊 Report" }, action_id: "dash:report" },
        { type: "button", text: { type: "plain_text", text: "📜 History" }, action_id: "dash:history" },
      ],
    },
  ];

  return blocks;
}

/** Register all dashboard action handlers on the Slack app. */
export function registerDashboardActions(slackApp: SlackApp, resolveUser: (slackId: string) => Promise<{ employeeId: string; role: AccessRole; name: string } | null>): void {

  // Back to dashboard
  slackApp.action("dash:back", async ({ ack, body, client }) => {
    await ack();
    try {
      const user = await resolveUser((body as any).user.id);
      const blocks = await buildDashboardBlocks(user?.role ?? "viewer", user?.employeeId ?? null);
      await client.chat.update({
        channel: (body as any).container.channel_id,
        ts: (body as any).container.message_ts,
        text: "COO Dashboard",
        blocks,
      });
    } catch (err) {
      logger.error({ err }, "dash:back failed");
    }
  });

  // Tasks
  slackApp.action("dash:tasks", async ({ ack, body, client }) => {
    await ack();
    try {
      const user = await resolveUser((body as any).user.id);
      const now = new Date();
      const conditions = user?.role === "viewer" && user.employeeId
        ? and(eq(tasks.assignedTo, user.employeeId), inArray(tasks.status, ["pending", "in_progress"]))
        : inArray(tasks.status, ["pending", "in_progress"]);
      const allTasks = await db.select().from(tasks).where(conditions);
      const priorityEmoji: Record<string, string> = { urgent: "🔴", high: "🟠", medium: "🟡", low: "🟢" };
      let text = "*📋 Active Tasks*\n━━━━━━━━━━━━━━━━━━━━━\n";
      if (!allTasks.length) {
        text += "Nessun task attivo.";
      } else {
        for (const t of allTasks) {
          const emoji = priorityEmoji[t.priority ?? "medium"] ?? "⚪";
          const due = t.dueDate ? ` (scade ${new Date(t.dueDate).toLocaleDateString("it-IT")})` : "";
          const overdue = t.dueDate && new Date(t.dueDate) < now ? " ⚠️" : "";
          text += `${emoji} [${t.status}] ${t.title}${due}${overdue}\n`;
        }
      }
      await client.chat.update({
        channel: (body as any).container.channel_id,
        ts: (body as any).container.message_ts,
        text: "Tasks",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: truncate(text) } },
          { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "← Dashboard" }, action_id: "dash:back" }] },
        ],
      });
    } catch (err) {
      logger.error({ err }, "dash:tasks failed");
    }
  });

  // Slack messages
  slackApp.action("dash:slack", async ({ ack, body, client }) => {
    await ack();
    const user = await resolveUser((body as any).user.id);
    if (!canAccessSection("dash:slack", user?.role ?? "viewer")) {
      await client.chat.postEphemeral({ channel: (body as any).container.channel_id, user: (body as any).user.id, text: "Non hai i permessi per visualizzare questa sezione." }).catch(() => {});
      return;
    }
    try {
      const slackMessages = await db.select().from(messageLogs)
        .where(and(eq(messageLogs.source, "slack"), sql`${messageLogs.receivedAt} > now() - interval '24 hours'`));
      const byChannel = new Map<string, typeof slackMessages>();
      for (const m of slackMessages) {
        const ch = m.chatTitle ?? "unknown";
        if (!byChannel.has(ch)) byChannel.set(ch, []);
        byChannel.get(ch)!.push(m);
      }
      let text = "*💬 Slack — Last 24h*\n━━━━━━━━━━━━━━━━━━━━━\n";
      if (!slackMessages.length) {
        text += "Nessun messaggio nelle ultime 24h.";
      } else {
        for (const [channel, msgs] of byChannel) {
          msgs.sort((a, b) => String(a.receivedAt ?? "").localeCompare(String(b.receivedAt ?? "")));
          text += `\n*${channel}* (${msgs.length} msgs)\n`;
          for (const m of msgs.slice(-5)) {
            const time = m.receivedAt ? new Date(m.receivedAt).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", timeZone: config.TIMEZONE || "Europe/Rome" }) : "";
            text += `  ${time} *${m.senderName ?? "?"}*: ${m.content.slice(0, 100)}\n`;
          }
          if (msgs.length > 5) text += `  _... +${msgs.length - 5} altri_\n`;
        }
      }
      await client.chat.update({
        channel: (body as any).container.channel_id,
        ts: (body as any).container.message_ts,
        text: "Slack",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: truncate(text) } },
          { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "← Dashboard" }, action_id: "dash:back" }] },
        ],
      });
    } catch (err) {
      logger.error({ err }, "dash:slack failed");
    }
  });

  // Email
  slackApp.action("dash:email", async ({ ack, body, client }) => {
    await ack();
    const user = await resolveUser((body as any).user.id);
    if (!canAccessSection("dash:email", user?.role ?? "viewer")) {
      await client.chat.postEphemeral({ channel: (body as any).container.channel_id, user: (body as any).user.id, text: "Non hai i permessi per visualizzare questa sezione." }).catch(() => {});
      return;
    }
    try {
      const emails = await getUnreadImportantEmails(5).catch(() => []);
      let text = "*📧 Unread Important Emails*\n━━━━━━━━━━━━━━━━━━━━━\n";
      if (!emails.length) {
        text += "Nessuna email non letta importante.";
      } else {
        for (const e of emails) {
          text += `\n*${e.subject}*\nDa: ${e.from}\n`;
          if (e.snippet) text += `_${e.snippet.slice(0, 120)}_\n`;
        }
      }
      await client.chat.update({
        channel: (body as any).container.channel_id,
        ts: (body as any).container.message_ts,
        text: "Email",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: truncate(text) } },
          { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "← Dashboard" }, action_id: "dash:back" }] },
        ],
      });
    } catch (err) {
      logger.error({ err }, "dash:email failed");
    }
  });

  // Calendar
  slackApp.action("dash:calendar", async ({ ack, body, client }) => {
    await ack();
    try {
      const calUser = await resolveUser((body as any).user.id);
      const calAuth = await getAuthForEmployee(calUser?.employeeId ?? null, calUser?.role === "owner");
      const events = calAuth ? await getTodayEvents(calAuth).catch(() => []) : [];
      let text = "*📅 Today's Calendar*\n━━━━━━━━━━━━━━━━━━━━━\n";
      if (!calAuth) {
        text += "_Collega il tuo Google Calendar con /coo-connect-google per vedere i tuoi eventi._";
      } else if (!events.length) {
        text += "Nessun evento oggi.";
      } else {
        for (const e of events) {
          const tz = config.TIMEZONE || "Europe/Rome";
          const start = e.start ? new Date(e.start).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", timeZone: tz }) : "";
          const end = e.end ? new Date(e.end).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", timeZone: tz }) : "";
          text += `\n🕒 ${start}–${end}\n*${e.summary}*\n`;
          if (e.location) text += `📍 ${e.location}\n`;
        }
      }
      await client.chat.update({
        channel: (body as any).container.channel_id,
        ts: (body as any).container.message_ts,
        text: "Calendar",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: truncate(text) } },
          { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "← Dashboard" }, action_id: "dash:back" }] },
        ],
      });
    } catch (err) {
      logger.error({ err }, "dash:calendar failed");
    }
  });

  // Notion
  slackApp.action("dash:notion", async ({ ack, body, client }) => {
    await ack();
    const user = await resolveUser((body as any).user.id);
    if (!canAccessSection("dash:notion", user?.role ?? "viewer")) {
      await client.chat.postEphemeral({ channel: (body as any).container.channel_id, user: (body as any).user.id, text: "Non hai i permessi per visualizzare questa sezione." }).catch(() => {});
      return;
    }
    try {
      if (!isNotionConfigured()) {
        await client.chat.update({
          channel: (body as any).container.channel_id,
          ts: (body as any).container.message_ts,
          text: "Notion not configured",
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: "*📝 Notion — Non Configurato*\nImposta NOTION_API_KEY per abilitare." } },
            { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "← Dashboard" }, action_id: "dash:back" }] },
          ],
        });
        return;
      }
      const data = await getNotionWorkspaceSummary();
      let text = "*📝 Notion Workspace*\n━━━━━━━━━━━━━━━━━━━━━\n";
      if (data.tasks.length) {
        const overdue = data.tasks.filter((t) => t.isOverdue);
        text += `\n*Tasks* (${data.tasks.length} totali${overdue.length ? `, ${overdue.length} scaduti` : ""})\n`;
        const byStatus = new Map<string, number>();
        for (const t of data.tasks) {
          const s = t.status || "No Status";
          byStatus.set(s, (byStatus.get(s) ?? 0) + 1);
        }
        for (const [status, count] of byStatus) text += `  ${status}: ${count}\n`;
        if (overdue.length) {
          text += `\n⚠️ *Scaduti:*\n`;
          for (const t of overdue.slice(0, 5)) {
            const due = t.dueDate ? new Date(t.dueDate).toLocaleDateString("it-IT") : "";
            text += `  - ${t.title} (${t.assignee ?? "non assegnato"}) scade ${due}\n`;
          }
        }
      } else {
        text += "Nessun task trovato.";
      }
      if (data.projects.length) {
        text += `\n*Projects* (${data.projects.length})\n`;
        for (const p of data.projects.slice(0, 10)) {
          text += `  - ${p.name}${p.status ? ` [${p.status}]` : ""}${p.owner ? ` — ${p.owner}` : ""}\n`;
        }
      }
      await client.chat.update({
        channel: (body as any).container.channel_id,
        ts: (body as any).container.message_ts,
        text: "Notion",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: truncate(text) } },
          { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "← Dashboard" }, action_id: "dash:back" }] },
        ],
      });
    } catch (err) {
      logger.error({ err }, "dash:notion failed");
    }
  });

  // Drive
  slackApp.action("dash:drive", async ({ ack, body, client }) => {
    await ack();
    const user = await resolveUser((body as any).user.id);
    if (!canAccessSection("dash:drive", user?.role ?? "viewer")) {
      await client.chat.postEphemeral({ channel: (body as any).container.channel_id, user: (body as any).user.id, text: "Non hai i permessi per visualizzare questa sezione." }).catch(() => {});
      return;
    }
    try {
      const files = await listDriveFiles(10);
      let text = "*📁 COO Drive Files*\n━━━━━━━━━━━━━━━━━━━━━\n";
      if (!files.length) {
        text += "Nessun file. Usa /coo-report-pdf per generarne uno.";
      } else {
        for (const f of files) {
          const date = f.createdTime ? new Date(f.createdTime).toLocaleDateString("it-IT") : "";
          text += `📄 ${f.name} (${date})\n`;
        }
        text += "\n_Usa /coo-drive per i link._";
      }
      await client.chat.update({
        channel: (body as any).container.channel_id,
        ts: (body as any).container.message_ts,
        text: "Drive",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: truncate(text) } },
          { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "← Dashboard" }, action_id: "dash:back" }] },
        ],
      });
    } catch (err) {
      logger.error({ err }, "dash:drive failed");
    }
  });

  // Report
  slackApp.action("dash:report", async ({ ack, body, client }) => {
    await ack();
    const user = await resolveUser((body as any).user.id);
    if (!canAccessSection("dash:report", user?.role ?? "viewer")) {
      await client.chat.postEphemeral({ channel: (body as any).container.channel_id, user: (body as any).user.id, text: "Non hai i permessi per visualizzare questa sezione." }).catch(() => {});
      return;
    }
    try {
      await client.chat.update({
        channel: (body as any).container.channel_id,
        ts: (body as any).container.message_ts,
        text: "Generando report...",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "*📊 Generazione report in corso...*" } }],
      });
      const now = new Date();
      const today = now.toISOString().split("T")[0];
      const [activeTasks, pendingMessages, calendarEvents, importantEmails, notionData] = await Promise.all([
        db.select().from(tasks).where(inArray(tasks.status, ["pending", "in_progress"])),
        db.select().from(messageLogs).where(and(eq(messageLogs.needsReply, true), eq(messageLogs.replied, false))),
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
        calendar_events: calendarEvents.map((e) => ({ summary: e.summary, start: e.start, end: e.end })),
        important_emails: importantEmails.map((e) => ({ from: e.from, subject: e.subject })),
        tasks: activeTasks.map((t) => ({ title: t.title, status: t.status, priority: t.priority })),
        pending_messages: pendingMessages.map((m) => ({ sender: m.senderName, urgency: m.urgency })),
        slack_by_channel: Array.from(byChannel, ([channel, msgs]) => ({ channel, message_count: msgs.length })),
      };
      if (notionData) {
        data.notion_tasks = notionData.tasks.slice(0, 10).map((t) => ({ title: t.title, status: t.status }));
      }
      const report = await agent.generateDailyReport(data);
      await client.chat.update({
        channel: (body as any).container.channel_id,
        ts: (body as any).container.message_ts,
        text: "Report",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: truncate(report) } },
          { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "← Dashboard" }, action_id: "dash:back" }] },
        ],
      });
    } catch (err) {
      logger.error({ err }, "dash:report failed");
      await client.chat.update({
        channel: (body as any).container.channel_id,
        ts: (body as any).container.message_ts,
        text: "Report failed",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: "Errore nella generazione del report. Usa /coo-report." } },
          { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "← Dashboard" }, action_id: "dash:back" }] },
        ],
      }).catch(() => {});
    }
  });

  // History
  slackApp.action("dash:history", async ({ ack, body, client }) => {
    await ack();
    const user = await resolveUser((body as any).user.id);
    if (!canAccessSection("dash:history", user?.role ?? "viewer")) {
      await client.chat.postEphemeral({ channel: (body as any).container.channel_id, user: (body as any).user.id, text: "Non hai i permessi per visualizzare questa sezione." }).catch(() => {});
      return;
    }
    try {
      const reports = await db.select().from(dailyReports).orderBy(desc(dailyReports.createdAt)).limit(10);
      let text = "*📜 Report History*\n━━━━━━━━━━━━━━━━━━━━━\n";
      if (!reports.length) {
        text += "Nessun report. Usa /coo-report per generarne uno.";
      } else {
        for (const r of reports) {
          const typeIcon = r.reportType === "daily" ? "📊" : "📋";
          const preview = r.content.replace(/<[^>]+>/g, "").replace(/[#*_~`\-|>]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
          const time = r.createdAt ? new Date(r.createdAt).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", timeZone: config.TIMEZONE || "Europe/Rome" }) : "";
          text += `${typeIcon} *${r.reportDate}* ${time} ${r.reportType}\n_${preview}..._\n`;
        }
        text += "\n_Usa /coo-reports [YYYY-MM-DD] per un report completo._";
      }
      await client.chat.update({
        channel: (body as any).container.channel_id,
        ts: (body as any).container.message_ts,
        text: "History",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: truncate(text) } },
          { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "← Dashboard" }, action_id: "dash:back" }] },
        ],
      });
    } catch (err) {
      logger.error({ err }, "dash:history failed");
    }
  });
}
