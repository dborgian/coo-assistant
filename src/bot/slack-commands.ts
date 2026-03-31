/**
 * Slack slash commands — replaces Telegram bot commands.
 *
 * Commands are registered via registerSlashCommands(slackApp, resolveUser).
 * Each /coo-* command mirrors the equivalent Telegram command.
 *
 * NOTE: Each command must also be registered in the Slack App settings at
 * api.slack.com → Your App → Slash Commands. With Socket Mode, no Request URL
 * is required — Socket Mode handles routing automatically.
 */
import type { App as SlackApp } from "@slack/bolt";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "../models/database.js";
import { clients, dailyReports, employees, messageLogs, tasks } from "../models/schema.js";
import { agent } from "../core/agent.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { getTodayEvents } from "../services/calendar-sync.js";
import { getUnreadImportantEmails } from "../services/email-manager.js";
import { getNotionWorkspaceSummary, isNotionConfigured } from "../services/notion-sync.js";
import { listDriveFiles, searchDriveFiles } from "../services/drive-manager.js";
import { generateDailyReportPdf, generateEmployeeReportPdf, generateWeeklyReportPdf } from "../services/pdf-generator.js";
import { uploadFileToDrive } from "../services/drive-manager.js";
import { getMonitoredSlackChannels, addMonitoredSlackChannel, removeMonitoredSlackChannel } from "./slack-monitor.js";
import { buildDashboardBlocks } from "./slack-dashboard.js";
import { processMeetingDocById } from "../services/meeting-notes.js";
import type { SlackAuthUser } from "./slack-monitor.js";

type ResolveFn = (slackId: string) => Promise<SlackAuthUser | null>;

function requireRole(user: SlackAuthUser | null, ...roles: string[]): boolean {
  return user !== null && roles.includes(user.role);
}

/** Register all /coo-* slash commands on the Slack app. */
export function registerSlashCommands(slackApp: SlackApp, resolveUser: ResolveFn): void {

  // /coo-dashboard — interactive dashboard with Block Kit buttons
  // Must use client.chat.postMessage (not respond) so the message TS is editable by action handlers
  slackApp.command("/coo-dashboard", async ({ ack, command, client, respond }) => {
    await ack();
    try {
      const user = await resolveUser(command.user_id);
      if (!user) { await respond("Non sei registrato nel sistema."); return; }
      const blocks = await buildDashboardBlocks(user.role, user.employeeId);
      await client.chat.postMessage({ channel: command.channel_id, text: "COO Dashboard", blocks });
    } catch (err) {
      logger.error({ err }, "/coo-dashboard failed");
      await respond("Errore nel caricamento del dashboard.");
    }
  });

  // /coo-status — quick operations overview
  slackApp.command("/coo-status", async ({ ack, command, respond }) => {
    await ack();
    try {
      const user = await resolveUser(command.user_id);
      if (!user) { await respond("Non sei registrato nel sistema."); return; }
      const now = new Date();
      if (user.role === "viewer" && user.employeeId) {
        const [myTaskRow] = await db.select({ count: sql<number>`count(*)` }).from(tasks)
          .where(and(eq(tasks.assignedTo, user.employeeId), inArray(tasks.status, ["pending", "in_progress"])));
        const [myOverdueRow] = await db.select({ count: sql<number>`count(*)` }).from(tasks)
          .where(and(eq(tasks.assignedTo, user.employeeId), inArray(tasks.status, ["pending", "in_progress"]), lt(tasks.dueDate, now)));
        const [totalRow] = await db.select({ count: sql<number>`count(*)` }).from(tasks).where(inArray(tasks.status, ["pending", "in_progress"]));
        let text = `*Il tuo status*\n\n*I tuoi task:* ${myTaskRow?.count ?? 0} attivi`;
        if (myOverdueRow?.count) text += ` (${myOverdueRow.count} scaduti)`;
        text += `\n*Task team totali:* ${totalRow?.count ?? 0}`;
        await respond(text);
        return;
      }
      const [taskRow] = await db.select({ count: sql<number>`count(*)` }).from(tasks).where(inArray(tasks.status, ["pending", "in_progress"]));
      const [overdueRow] = await db.select({ count: sql<number>`count(*)` }).from(tasks).where(and(inArray(tasks.status, ["pending", "in_progress"]), lt(tasks.dueDate, now)));
      const [msgRow] = await db.select({ count: sql<number>`count(*)` }).from(messageLogs).where(and(eq(messageLogs.needsReply, true), eq(messageLogs.replied, false)));
      const [empRow] = await db.select({ count: sql<number>`count(*)` }).from(employees).where(eq(employees.isActive, true));
      const [cliRow] = await db.select({ count: sql<number>`count(*)` }).from(clients).where(eq(clients.isActive, true));
      let text = `*Operations Status*\n\n*Tasks:* ${taskRow?.count ?? 0} attivi`;
      if (overdueRow?.count) text += ` (${overdueRow.count} scaduti)`;
      text += `\n*Messaggi in attesa:* ${msgRow?.count ?? 0}\n*Team:* ${empRow?.count ?? 0} membri\n*Clienti:* ${cliRow?.count ?? 0} attivi`;
      await respond(text);
    } catch (err) {
      logger.error({ err }, "/coo-status failed");
      await respond("Errore nel caricamento dello status.");
    }
  });

  // /coo-tasks [overdue] — task list
  slackApp.command("/coo-tasks", async ({ ack, command, respond }) => {
    await ack();
    try {
      const user = await resolveUser(command.user_id);
      if (!user) { await respond("Non sei registrato nel sistema."); return; }
      const args = command.text.trim();
      const now = new Date();
      const baseConditions = args.includes("overdue")
        ? and(inArray(tasks.status, ["pending", "in_progress"]), lt(tasks.dueDate, now))
        : inArray(tasks.status, ["pending", "in_progress"]);
      const conditions = user.role === "viewer" && user.employeeId
        ? and(baseConditions, eq(tasks.assignedTo, user.employeeId))
        : baseConditions;
      const allTasks = await db.select().from(tasks).where(conditions);
      if (!allTasks.length) { await respond("Nessun task attivo."); return; }
      const priorityEmoji: Record<string, string> = { urgent: "🔴", high: "🟠", medium: "🟡", low: "🟢" };
      let text = "*Active Tasks*\n\n";
      for (const t of allTasks) {
        const emoji = priorityEmoji[t.priority ?? "medium"] ?? "⚪";
        const due = t.dueDate ? ` (scade ${new Date(t.dueDate).toLocaleDateString("it-IT")})` : "";
        text += `${emoji} [${t.status}] ${t.title}${due}\n`;
      }
      if (text.length > 3000) text = text.slice(0, 3000) + "\n_... (troppi task, usa /coo-dashboard per filtrare)_";
      await respond(text);
    } catch (err) {
      logger.error({ err }, "/coo-tasks failed");
      await respond("Errore nel caricamento dei task.");
    }
  });

  // /coo-report — AI text operations report
  slackApp.command("/coo-report", async ({ ack, command, respond }) => {
    await ack();
    try {
      const user = await resolveUser(command.user_id);
      if (!user || !requireRole(user, "owner", "admin")) { await respond("Accesso non autorizzato."); return; }
      await respond("Generando report operativo...");
      const today = new Date().toISOString().split("T")[0];
      const [activeTasks, pendingMessages, calendarEvents, importantEmails] = await Promise.all([
        db.select().from(tasks).where(inArray(tasks.status, ["pending", "in_progress"])),
        db.select().from(messageLogs).where(and(eq(messageLogs.needsReply, true), eq(messageLogs.replied, false))),
        getTodayEvents().catch(() => []),
        getUnreadImportantEmails(5).catch(() => []),
      ]);
      const slackMsgs = await db.select().from(messageLogs).where(and(sql`${messageLogs.receivedAt}::date = ${today}`, eq(messageLogs.source, "slack")));
      const byChannel = new Map<string, typeof slackMsgs>();
      for (const m of slackMsgs) {
        const ch = m.chatTitle ?? "unknown";
        if (!byChannel.has(ch)) byChannel.set(ch, []);
        byChannel.get(ch)!.push(m);
      }
      const report = await agent.generateDailyReport({
        date: today,
        calendar_events: calendarEvents.map((e) => ({ summary: e.summary, start: e.start, end: e.end })),
        important_emails: importantEmails.map((e) => ({ from: e.from, subject: e.subject, snippet: e.snippet })),
        tasks: activeTasks.map((t) => ({ title: t.title, status: t.status, priority: t.priority, due: t.dueDate })),
        pending_messages: pendingMessages.map((m) => ({ sender: m.senderName, chat: m.chatTitle, urgency: m.urgency })),
        slack_by_channel: Array.from(byChannel, ([channel, msgs]) => ({ channel, message_count: msgs.length })),
      });
      await db.insert(dailyReports).values({ reportDate: today, reportType: "on_demand", content: report });
      const chunks = report.match(/[\s\S]{1,3900}/g) ?? [report];
      for (const chunk of chunks) await respond(chunk);
    } catch (err) {
      logger.error({ err }, "/coo-report failed");
      await respond("Errore nella generazione del report.");
    }
  });

  // /coo-report-pdf [weekly] — PDF report + Drive upload + Slack file
  slackApp.command("/coo-report-pdf", async ({ ack, command, respond, client }) => {
    await ack();
    try {
      const user = await resolveUser(command.user_id);
      if (!user || !requireRole(user, "owner", "admin")) { await respond("Accesso non autorizzato."); return; }
      const args = command.text.trim();
      await respond("Generando PDF report...");

      if (args.includes("weekly") || args.includes("settimana")) {
        const now = new Date();
        const dayOfWeek = now.getDay();
        const monday = new Date(now);
        monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
        monday.setHours(0, 0, 0, 0);
        const pdf = await generateWeeklyReportPdf(monday, now);
        const fileName = `weekly-report-${monday.toISOString().split("T")[0]}.pdf`;
        const driveFile = await uploadFileToDrive(fileName, pdf, "application/pdf", config.DRIVE_DAILY_FOLDER_ID || undefined);
        await client.filesUploadV2({ channel_id: command.channel_id, file: pdf, filename: fileName, initial_comment: driveFile ? `Salvato su Drive: ${driveFile.webViewLink}` : undefined });
        return;
      }

      // Daily PDF
      const today = new Date().toISOString().split("T")[0];
      const [activeTasks, doneTasks, allMsgs] = await Promise.all([
        db.select().from(tasks).where(inArray(tasks.status, ["pending", "in_progress"])),
        db.select().from(tasks).where(eq(tasks.status, "done")),
        db.select().from(messageLogs).where(sql`${messageLogs.receivedAt}::date = ${today}`),
      ]);
      const overdueTasks = activeTasks.filter((t) => t.dueDate && new Date(t.dueDate) < new Date());
      const [calEvts, emails] = await Promise.all([getTodayEvents().catch(() => []), getUnreadImportantEmails(5).catch(() => [])]);
      const slackMsgs = allMsgs.filter((m) => m.source === "slack");
      const notionData = await (await import("../services/notion-sync.js")).getNotionWorkspaceSummary().catch(() => null);
      const narrative = await agent.generateDailyReport({
        date: today,
        calendar_events: calEvts.map((e) => ({ summary: e.summary, start: e.start, end: e.end })),
        important_emails: emails.map((e) => ({ from: e.from, subject: e.subject, snippet: e.snippet })),
        tasks: activeTasks.map((t) => ({ title: t.title, status: t.status, priority: t.priority, due: t.dueDate })),
        pending_messages: allMsgs.filter((m) => m.needsReply && !m.replied).map((m) => ({ sender: m.senderName, urgency: m.urgency })),
        slack_messages: slackMsgs.length,
      });
      await db.insert(dailyReports).values({ reportDate: today, reportType: "on_demand", content: narrative });
      const srcCount = new Map<string, number>();
      for (const m of allMsgs) srcCount.set(m.source, (srcCount.get(m.source) ?? 0) + 1);
      const srcColors: Record<string, string> = { slack: "#611f69", gmail: "#ea4335" };
      const pdf = await generateDailyReportPdf({
        narrative, date: today,
        taskCount: activeTasks.length, overdueCount: overdueTasks.length, doneCount: doneTasks.length,
        slackMsgCount: slackMsgs.length, emailCount: emails.length, calendarCount: calEvts.length,
        notionTaskCount: notionData?.tasks.length ?? 0,
        taskList: activeTasks.map((t) => ({ title: t.title, status: t.status, priority: t.priority, due: t.dueDate })),
        msgBySource: Array.from(srcCount, ([s, v]) => ({ label: s, value: v, color: srcColors[s] ?? "#888888" })),
      });
      const fileName = `daily-report-${today}.pdf`;
      const driveFile = await uploadFileToDrive(fileName, pdf, "application/pdf", config.DRIVE_DAILY_FOLDER_ID || undefined);
      await client.filesUploadV2({ channel_id: command.channel_id, file: pdf, filename: fileName, initial_comment: driveFile ? `Salvato su Drive: ${driveFile.webViewLink}` : undefined });
    } catch (err) {
      logger.error({ err }, "/coo-report-pdf failed");
      await respond("Errore nella generazione del PDF.");
    }
  });

  // /coo-employee-report [name] — employee PDF + Drive
  slackApp.command("/coo-employee-report", async ({ ack, command, respond, client }) => {
    await ack();
    try {
      const user = await resolveUser(command.user_id);
      if (!user || !requireRole(user, "owner", "admin")) { await respond("Accesso non autorizzato."); return; }
      const name = command.text.trim();
      if (!name) { await respond("Uso: /coo-employee-report [nome]\nEsempio: /coo-employee-report Damiano"); return; }
      await respond(`Generando report per ${name}...`);
      const now = new Date();
      const weekAgo = new Date(now);
      weekAgo.setDate(weekAgo.getDate() - 7);
      const pdf = await generateEmployeeReportPdf(name, weekAgo, now);
      const fileName = `employee-${name.toLowerCase()}-${now.toISOString().split("T")[0]}.pdf`;
      const driveFile = await uploadFileToDrive(fileName, pdf, "application/pdf", config.DRIVE_EMPLOYEE_FOLDER_ID || undefined);
      await client.filesUploadV2({ channel_id: command.channel_id, file: pdf, filename: fileName, initial_comment: driveFile ? `Salvato su Drive: ${driveFile.webViewLink}` : undefined });
    } catch (err) {
      logger.error({ err }, "/coo-employee-report failed");
      await respond("Errore nella generazione del report employee.");
    }
  });

  // /coo-drive [search query] — Drive files
  slackApp.command("/coo-drive", async ({ ack, command, respond }) => {
    await ack();
    try {
      const user = await resolveUser(command.user_id);
      if (!user || !requireRole(user, "owner", "admin")) { await respond("Accesso non autorizzato."); return; }
      const args = command.text.trim();
      if (args.startsWith("search ")) {
        const query = args.slice(7).trim();
        const files = await searchDriveFiles(query);
        if (!files.length) { await respond(`Nessun file trovato per "${query}".`); return; }
        let text = `*Drive Search: "${query}"*\n\n`;
        for (const f of files) {
          const date = f.createdTime ? new Date(f.createdTime).toLocaleDateString("it-IT") : "";
          text += `📄 <${f.webViewLink}|${f.name}> (${date})\n`;
        }
        await respond(text);
        return;
      }
      const files = await listDriveFiles(10);
      if (!files.length) { await respond("Nessun file. Genera un report con /coo-report-pdf prima."); return; }
      let text = "*📁 COO Drive Files*\n\n";
      for (const f of files) {
        const date = f.createdTime ? new Date(f.createdTime).toLocaleDateString("it-IT") : "";
        text += `📄 <${f.webViewLink}|${f.name}> (${date})\n`;
      }
      await respond(text);
    } catch (err) {
      logger.error({ err }, "/coo-drive failed");
      await respond("Errore nel caricamento dei file Drive.");
    }
  });

  // /coo-reports [YYYY-MM-DD] — report history
  slackApp.command("/coo-reports", async ({ ack, command, respond }) => {
    await ack();
    try {
      const user = await resolveUser(command.user_id);
      if (!user || !requireRole(user, "owner", "admin")) { await respond("Accesso non autorizzato."); return; }
      const args = command.text.trim();
      if (args) {
        const [report] = await db.select().from(dailyReports).where(eq(dailyReports.reportDate, args)).orderBy(desc(dailyReports.createdAt)).limit(1);
        if (!report) { await respond(`Nessun report trovato per *${args}*.`); return; }
        const header = `${report.reportType === "daily" ? "📊" : "📋"} Report ${report.reportDate} (${report.reportType})\n\n`;
        const full = header + report.content;
        const chunks = full.match(/[\s\S]{1,3900}/g) ?? [full];
        for (const chunk of chunks) await respond(chunk);
        return;
      }
      const reports = await db.select().from(dailyReports).orderBy(desc(dailyReports.createdAt)).limit(10);
      if (!reports.length) { await respond("Nessun report ancora. Usa /coo-report per generarne uno."); return; }
      let text = "*📋 Report History*\n\n";
      for (const r of reports) {
        const typeIcon = r.reportType === "daily" ? "📊" : "📋";
        const preview = r.content.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
        const time = r.createdAt ? new Date(r.createdAt).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }) : "";
        text += `${typeIcon} *${r.reportDate}* ${time} ${r.reportType}\n_${preview}..._\n`;
      }
      text += "\n_Usa /coo-reports [YYYY-MM-DD] per un report completo._";
      await respond(text);
    } catch (err) {
      logger.error({ err }, "/coo-reports failed");
      await respond("Errore nel caricamento dello storico.");
    }
  });

  // /coo-notion — Notion workspace summary
  slackApp.command("/coo-notion", async ({ ack, command, respond }) => {
    await ack();
    try {
      const user = await resolveUser(command.user_id);
      if (!user || !requireRole(user, "owner", "admin")) { await respond("Accesso non autorizzato."); return; }
      if (!isNotionConfigured()) { await respond("Notion non è configurato. Imposta NOTION_API_KEY."); return; }
      await respond("Caricando Notion...");
      const data = await getNotionWorkspaceSummary();
      let text = "*📝 Notion Workspace*\n\n";
      if (data.tasks.length) {
        const overdue = data.tasks.filter((t) => t.isOverdue);
        text += `*Tasks* (${data.tasks.length} totali${overdue.length ? `, ${overdue.length} scaduti` : ""})\n`;
        const byStatus = new Map<string, number>();
        for (const t of data.tasks) byStatus.set(t.status || "No Status", (byStatus.get(t.status || "No Status") ?? 0) + 1);
        for (const [s, c] of byStatus) text += `  ${s}: ${c}\n`;
        if (overdue.length) {
          text += `\n⚠️ *Scaduti:*\n`;
          for (const t of overdue) {
            const due = t.dueDate ? new Date(t.dueDate).toLocaleDateString("it-IT") : "";
            text += `  - ${t.title} (${t.assignee ?? "non assegnato"}) scade ${due}\n`;
          }
        }
      } else {
        text += "Nessun task trovato.\n";
      }
      if (data.projects.length) {
        text += `\n*Projects* (${data.projects.length})\n`;
        for (const p of data.projects) text += `  - ${p.name}${p.status ? ` [${p.status}]` : ""}${p.owner ? ` — ${p.owner}` : ""}\n`;
      }
      const chunks = text.match(/[\s\S]{1,3900}/g) ?? [text];
      for (const chunk of chunks) await respond(chunk);
    } catch (err) {
      logger.error({ err }, "/coo-notion failed");
      await respond("Errore nel caricamento di Notion.");
    }
  });

  // /coo-slack-report — 24h Slack digest
  slackApp.command("/coo-slack-report", async ({ ack, command, respond }) => {
    await ack();
    try {
      const user = await resolveUser(command.user_id);
      if (!user || !requireRole(user, "owner", "admin")) { await respond("Accesso non autorizzato."); return; }
      const slackMessages = await db.select().from(messageLogs).where(and(eq(messageLogs.source, "slack"), sql`${messageLogs.receivedAt} > now() - interval '24 hours'`));
      if (!slackMessages.length) { await respond("Nessun messaggio Slack nelle ultime 24h."); return; }
      const byChannel = new Map<string, typeof slackMessages>();
      for (const m of slackMessages) {
        const ch = m.chatTitle ?? "unknown";
        if (!byChannel.has(ch)) byChannel.set(ch, []);
        byChannel.get(ch)!.push(m);
      }
      for (const msgs of byChannel.values()) msgs.sort((a, b) => String(a.receivedAt ?? "").localeCompare(String(b.receivedAt ?? "")));
      const urgencyIcon: Record<string, string> = { critical: "🔴", high: "🟠", normal: "🟡", low: "🟢" };
      const today = new Date().toLocaleDateString("it-IT");
      let text = `*📊 Slack Report — ${today}*\n`;
      for (const [channel, msgs] of byChannel) {
        text += `\n*${channel}* (${msgs.length} messaggi)\n`;
        for (const m of msgs) {
          const time = m.receivedAt ? new Date(m.receivedAt).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }) : "";
          const icon = urgencyIcon[m.urgency ?? "normal"] ?? "⚪";
          text += `  ${time} ${icon} *${m.senderName ?? "?"}*: ${m.content.slice(0, 150)}\n`;
        }
      }
      text += `\n_Totale: ${slackMessages.length} messaggi in ${byChannel.size} canali_`;
      const chunks = text.match(/[\s\S]{1,3900}/g) ?? [text];
      for (const chunk of chunks) await respond(chunk);
    } catch (err) {
      logger.error({ err }, "/coo-slack-report failed");
      await respond("Errore nel caricamento del report Slack.");
    }
  });

  // /coo-slack-summary — AI Slack summary
  slackApp.command("/coo-slack-summary", async ({ ack, command, respond }) => {
    await ack();
    try {
      const user = await resolveUser(command.user_id);
      if (!user || !requireRole(user, "owner", "admin")) { await respond("Accesso non autorizzato."); return; }
      const slackMessages = await db.select().from(messageLogs).where(and(eq(messageLogs.source, "slack"), sql`${messageLogs.receivedAt} > now() - interval '24 hours'`));
      if (!slackMessages.length) { await respond("Nessun messaggio Slack nelle ultime 24h."); return; }
      await respond("Analizzando le conversazioni Slack...");
      const byChannel = new Map<string, typeof slackMessages>();
      for (const m of slackMessages) {
        const ch = m.chatTitle ?? "unknown";
        if (!byChannel.has(ch)) byChannel.set(ch, []);
        byChannel.get(ch)!.push(m);
      }
      const channelData = Array.from(byChannel, ([channel, msgs]) => ({
        channel, message_count: msgs.length,
        conversation: msgs.sort((a, b) => String(a.receivedAt ?? "").localeCompare(String(b.receivedAt ?? ""))).map((m) => ({ sender: m.senderName, text: m.content })),
      }));
      const summary = await agent.think(
        `Riassumi le conversazioni Slack delle ultime 24h. Per ogni canale: sommario, decisioni chiave, action items, urgenze. Sii conciso e usa bullet points.`,
        { slack_channels: channelData, total_messages: slackMessages.length },
      );
      const chunks = summary.match(/[\s\S]{1,3900}/g) ?? [summary];
      for (const chunk of chunks) await respond(chunk);
    } catch (err) {
      logger.error({ err }, "/coo-slack-summary failed");
      await respond("Errore nella generazione del sommario.");
    }
  });

  // /coo-remind [person] [task] — set reminder
  slackApp.command("/coo-remind", async ({ ack, command, respond }) => {
    await ack();
    try {
      const user = await resolveUser(command.user_id);
      if (!user || !requireRole(user, "owner", "admin")) { await respond("Accesso non autorizzato."); return; }
      const args = command.text.trim().split(/\s+/);
      if (args.length < 2 || !args[0]) { await respond("Uso: /coo-remind [persona] [descrizione task]\nEsempio: /coo-remind John Invia il report Q1"); return; }
      const personName = args[0];
      const taskDesc = args.slice(1).join(" ");
      const [employee] = await db.select().from(employees).where(sql`${employees.name} ILIKE ${"%" + personName + "%"}`).limit(1);
      await db.insert(tasks).values({
        title: `Reminder: ${taskDesc}`,
        description: `Reminder per ${personName}: ${taskDesc}`,
        status: "pending",
        priority: "high",
        assignedTo: employee?.id ?? null,
        source: "manual",
      });
      let reply = `Reminder impostato per *${personName}*: ${taskDesc}`;
      if (employee?.email) reply += `\n_(Verrà inviata anche un'email a ${employee.email})_`;
      await respond(reply);
    } catch (err) {
      logger.error({ err }, "/coo-remind failed");
      await respond("Errore nell'impostazione del reminder.");
    }
  });

  // /coo-add-employee [name] [email] [role] [access:admin|viewer] [tz:timezone]
  slackApp.command("/coo-add-employee", async ({ ack, command, respond }) => {
    await ack();
    try {
      const user = await resolveUser(command.user_id);
      if (!user || !requireRole(user, "owner")) { await respond("Solo il proprietario può aggiungere dipendenti."); return; }
      const args = command.text.trim().split(/\s+/);
      if (!args[0]) {
        await respond("Uso: /coo-add-employee [nome] [email] [ruolo] [access:admin|viewer] [tz:timezone]\nEsempio: /coo-add-employee Mario mario@azienda.it Developer access:admin tz:Europe/Rome");
        return;
      }
      const accessArg = args.find((a) => a.startsWith("access:"));
      const tzArg = args.find((a) => a.startsWith("tz:"));
      const filteredArgs = args.filter((a) => !a.startsWith("access:") && !a.startsWith("tz:"));
      const accessRole = accessArg ? accessArg.split(":")[1] : "viewer";
      const timezone = tzArg ? tzArg.slice(3) : null;
      if (!["owner", "admin", "viewer"].includes(accessRole)) { await respond("Ruolo non valido. Usa: owner, admin, o viewer."); return; }
      const name = filteredArgs[0];
      const email = filteredArgs[1] ?? null;
      const role = filteredArgs.slice(2).join(" ") || null;
      await db.insert(employees).values({ name, email, role, accessRole, timezone });
      const tzInfo = timezone ? `, tz: ${timezone}` : "";
      await respond(`Aggiunto dipendente: *${name}* (${role ?? "nessun ruolo"}, accesso: ${accessRole}${tzInfo})`);
    } catch (err) {
      logger.error({ err }, "/coo-add-employee failed");
      await respond("Errore nell'aggiunta del dipendente.");
    }
  });

  // /coo-add-client [name] [company] [email]
  slackApp.command("/coo-add-client", async ({ ack, command, respond }) => {
    await ack();
    try {
      const user = await resolveUser(command.user_id);
      if (!user || !requireRole(user, "owner")) { await respond("Solo il proprietario può aggiungere clienti."); return; }
      const args = command.text.trim().split(/\s+/);
      if (!args[0]) { await respond("Uso: /coo-add-client [nome] [azienda] [email]\nEsempio: /coo-add-client Acme AcmeCorp acme@example.com"); return; }
      const name = args[0], company = args[1] ?? null, email = args[2] ?? null;
      await db.insert(clients).values({ name, company, email });
      await respond(`Aggiunto cliente: *${name}* (${company ?? "nessuna azienda"})`);
    } catch (err) {
      logger.error({ err }, "/coo-add-client failed");
      await respond("Errore nell'aggiunta del cliente.");
    }
  });

  // /coo-slack-monitor [list|add|remove] [channel_id]
  slackApp.command("/coo-slack-monitor", async ({ ack, command, respond }) => {
    await ack();
    try {
      const user = await resolveUser(command.user_id);
      if (!user || !requireRole(user, "owner")) { await respond("Solo il proprietario può configurare il monitoraggio."); return; }
      const args = command.text.trim().split(/\s+/);
      if (!args[0] || args[0] === "list") {
        const channels = getMonitoredSlackChannels();
        if (channels.length) await respond(`*Canali Slack monitorati:*\n${channels.join("\n")}`);
        else await respond("Nessun canale monitorato. Usa /coo-slack-monitor add [channel_id]");
      } else if (args[0] === "add" && args[1]) {
        addMonitoredSlackChannel(args[1]);
        await respond(`Ora monitorando il canale: ${args[1]}`);
      } else if (args[0] === "remove" && args[1]) {
        removeMonitoredSlackChannel(args[1]);
        await respond(`Smesso di monitorare il canale: ${args[1]}`);
      } else {
        await respond("Uso: /coo-slack-monitor [list|add|remove] [channel_id]");
      }
    } catch (err) {
      logger.error({ err }, "/coo-slack-monitor failed");
      await respond("Errore nella configurazione del monitoraggio.");
    }
  });

  // /coo-process-meeting — manually process a Google Doc as meeting notes
  slackApp.command("/coo-process-meeting", async ({ ack, command, respond }) => {
    await ack();
    try {
      const user = await resolveUser(command.user_id);
      if (!requireRole(user, "owner", "admin")) { await respond("Accesso negato."); return; }
      const docUrl = command.text.trim();
      if (!docUrl) { await respond("Uso: `/coo-process-meeting [URL o ID del Google Doc]`"); return; }
      await respond("Elaborazione in corso...");
      const result = await processMeetingDocById(docUrl);
      await respond(result);
    } catch (err) {
      logger.error({ err }, "/coo-process-meeting failed");
      await respond("Errore nell'elaborazione del documento.");
    }
  });

  // /coo-help — role-aware command list
  slackApp.command("/coo-help", async ({ ack, command, respond }) => {
    await ack();
    try {
      const user = await resolveUser(command.user_id);
      const role = user?.role ?? "viewer";
      const viewerCmds =
        "*/coo-dashboard* — Dashboard interattiva\n" +
        "*/coo-tasks* [overdue] — Task attivi\n" +
        "*/coo-status* — Status operativo\n";
      const adminCmds =
        "*/coo-report* — Report operativo\n" +
        "*/coo-report-pdf* [weekly] — Report PDF\n" +
        "*/coo-employee-report* [nome] — Report dipendente\n" +
        "*/coo-reports* [data] — Storico report\n" +
        "*/coo-notion* — Notion workspace\n" +
        "*/coo-drive* [search query] — File Drive\n" +
        "*/coo-slack-report* — Digest Slack 24h\n" +
        "*/coo-slack-summary* — Riassunto AI Slack\n" +
        "*/coo-remind* [persona] [task] — Imposta reminder\n" +
        "*/coo-connect-google* — Connetti Google\n" +
        "*/coo-disconnect-google* — Disconnetti Google\n";
      const ownerCmds =
        "*/coo-add-employee* [nome] [email] [ruolo] [access:...] — Aggiungi dipendente\n" +
        "*/coo-add-client* [nome] [azienda] [email] — Aggiungi cliente\n" +
        "*/coo-slack-monitor* [list|add|remove] — Configura monitoraggio\n";
      let text = "*COO Assistant — Comandi*\n\n" + viewerCmds;
      if (role === "admin" || role === "owner") text += "\n" + adminCmds;
      if (role === "owner") text += "\n" + ownerCmds;
      text += "\nOpure scrivi direttamente nel DM o menzionami in un canale per domande libere.";
      await respond(text);
    } catch (err) {
      logger.error({ err }, "/coo-help failed");
      await respond("Errore nel caricamento dell'help.");
    }
  });

  // /coo-connect-google and /coo-disconnect-google are registered in onboarding
  // They are imported and registered from there to avoid circular imports.
}
