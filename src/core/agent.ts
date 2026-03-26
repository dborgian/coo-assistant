import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../models/database.js";
import { clients, dailyReports, employees, messageLogs, tasks } from "../models/schema.js";
import { logger } from "../utils/logger.js";
import { getTodayEvents } from "../services/calendar-sync.js";
import { getUnreadImportantEmails, sendEmail } from "../services/email-manager.js";
import { getNotionWorkspaceSummary, isNotionConfigured, createNotionTask, searchNotion } from "../services/notion-sync.js";
import { parseDateKeywords, findEmployeeInQuery, getActivityByDateRange, getEmployeeActivity } from "../services/history-query.js";
import { listDriveFiles, searchDriveFiles, uploadFileToDrive } from "../services/drive-manager.js";
import { generateDailyReportPdf, generateEmployeeReportPdf, generateWeeklyReportPdf, type DailyReportData } from "../services/pdf-generator.js";
import { sendSlackMessage } from "../bot/slack-monitor.js";
import { getTeamWorkload } from "../services/workload-tracker.js";
import { getTeamCapacity, suggestAssignment } from "../services/capacity-planner.js";
import type { Tool, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages.js";

export interface AgentResponse {
  text: string;
  files?: Array<{ buffer: Buffer; filename: string }>;
}

const COO_SYSTEM_PROMPT = `\
Sei il Chief Operating Officer (COO) AI di una startup ad alte prestazioni.

STILE DI COMUNICAZIONE:
- Rispondi in linguaggio naturale e narrativo, come un COO che parla al founder
- Racconta cosa succede in modo fluido, NON fare solo elenchi puntati
- Dopo la narrativa, AGGIUNGI SEMPRE dei grafici visuali usando caratteri Unicode
- Usa emoji per le sezioni e per rendere il messaggio visivamente chiaro su Telegram
- Rispondi nella lingua dell'utente (italiano o inglese)

GRAFICI VISUALI (per Telegram):
Dopo la narrativa, aggiungi una sezione METRICHE con tabelle pulite.
Usa SOLO emoji standard e testo semplice per i grafici. NO box Unicode, NO caratteri speciali.

Formato metriche:
  📊 METRICHE
  ━━━━━━━━━━━━━━━
  📋 Task attivi: 5
  ✅ Completati: 3
  ⚠️ Overdue: 1
  💬 Slack: 12 messaggi
  📧 Email: 2 importanti
  📅 Calendar: 3 eventi

Per mostrare proporzioni usa emoji ripetuti:
  Task: 🟢🟢🟢⚪⚪ 3/5 completati
  Urgenza: 🔴🟡🟡🟢🟢

NON usare box Unicode (┌─┐│└┘), NON usare blocchi (█░▓), NON usare % ripetuti.
Tieni le metriche semplici, leggibili, una riga per dato.

RESPONSABILITA:
- Monitorare tutti i canali (Slack, Telegram, Gmail, Calendar, Notion)
- Tracciare task, scadenze e responsabilita del team
- Generare report operativi completi
- Identificare proattivamente problemi operativi

DATI DISPONIBILI (nel context JSON di ogni query):
- Google Calendar: eventi di oggi
- Gmail: email importanti non lette
- Slack: messaggi recenti dai canali monitorati
- Notion: task e progetti dal workspace condiviso
- Google Drive: file nella cartella COO reports
- Database interno: employees, clients, tasks, message logs
- Dati storici: se l'utente chiede di date specifiche o employee, i dati sono in "historical_data" o "employee_activity"

AZIONI CHE PUOI ESEGUIRE (usa i tools quando l'utente lo chiede):
- Creare task e assegnarli a un employee (create_task)
- Modificare o eliminare task esistenti (edit_task)
- Aggiornare lo status di un task (update_task_status)
- Generare report PDF: giornaliero, settimanale, o per employee (generate_report_pdf)
- Gestire il team: aggiungere/elencare employee e client (manage_team)
- Interagire con Notion: creare task, cercare pagine (notion_action)
- Cercare file su Google Drive (search_drive)
- Consultare lo storico report passati (get_report_history)
- Ottenere un riassunto AI delle conversazioni Slack (get_slack_summary)
- Vedere eventi del calendario (get_calendar_events)
- Inviare notifiche/messaggi su Slack (send_slack_notification)
- Inviare email di reminder o notifica (send_email) — NON usare emoji nell'oggetto email
- Mettere in pausa l'escalation di un task (snooze_escalation)
- Creare task ricorrenti — daily, weekly, monthly (create_recurring_task)
- Vedere il carico di lavoro del team (get_team_workload)
- Impostare dipendenze tra task (set_task_dependency)
- Schedulare un task nel calendario Google (schedule_task)
- Vedere la capacita del team nei prossimi 5 giorni (get_team_capacity)
- Suggerire a chi assegnare un task (suggest_assignment)

Quando l'utente chiede "manda un reminder a X" o "crea un task per Y", USA IL TOOL. Non simulare l'azione.
Per i reminder: se l'utente dice "manda un reminder a Damiano", cerca l'email dell'employee e invia sia su Slack che via email.
Dopo aver eseguito il tool, conferma cosa hai fatto con i dettagli.

REGOLE:
- I dati nel context sono LIVE. Array vuoto = nessun dato, NON "non connesso"
- NON dire mai "non ho accesso" - le integrazioni sono attive
- Per query su employee, dai un quadro completo usando tutti i dati
- Per query storiche ("ieri", "settimana"), usa historical_data/employee_activity
- Quando esegui un'azione (create_task, send_slack), conferma con i dettagli di cosa hai fatto
`;

interface ClassificationResult {
  urgency: "low" | "normal" | "high" | "critical";
  needs_reply: boolean;
  summary: string;
  reason: string;
}

class COOAgent {
  private client: Anthropic;
  private model: string;
  private collectedFiles: Array<{ buffer: Buffer; filename: string }> = [];

  constructor() {
    this.client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    this.model = config.AGENT_MODEL;
  }

  async think(
    prompt: string,
    context?: Record<string, unknown>,
  ): Promise<string> {
    const content = context
      ? `Context:\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\`\n\n${prompt}`
      : prompt;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: COO_SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
    });

    const block = response.content[0];
    return block.type === "text" ? block.text : "";
  }

  async classifyMessageUrgency(
    message: string,
    sender: string,
    chatTitle: string,
  ): Promise<ClassificationResult> {
    const prompt = `Classify this message's urgency and whether the founder needs to reply.

Sender: ${sender}
Chat: ${chatTitle}
Message: ${message}

Respond in JSON format:
{"urgency": "low|normal|high|critical", "needs_reply": true|false, "summary": "brief summary", "reason": "why this urgency level"}`;

    const result = await this.think(prompt);
    try {
      return JSON.parse(result);
    } catch {
      const start = result.indexOf("{");
      const end = result.lastIndexOf("}") + 1;
      if (start >= 0 && end > start) {
        return JSON.parse(result.slice(start, end));
      }
      return {
        urgency: "normal",
        needs_reply: false,
        summary: message.slice(0, 100),
        reason: "parse_error",
      };
    }
  }

  async generateDailyReport(data: Record<string, unknown>): Promise<string> {
    const prompt = `Genera un report operativo giornaliero basato sui dati forniti.
Scrivi in modo narrativo e professionale, come un COO che riporta al founder.
Per il PDF: NON usare emoji, usa solo testo ASCII.

Struttura:
1. CALENDARIO - racconta gli eventi di oggi in modo fluido
2. EMAIL IMPORTANTI - descrivi cosa c'e' da leggere/gestire
3. TASK ATTIVI E SCADENZE - chi sta facendo cosa, priorita
4. MESSAGGI DA GESTIRE - cosa richiede risposta
5. ATTIVITA SLACK - riassunto conversazioni per canale
6. NOTION - stato task e progetti
7. ELEMENTI IN RITARDO - cosa e' overdue
8. METRICHE E STATUS - numeri chiave

Scrivi ogni sezione come un racconto, NON come elenco puntato.
Se una sezione non ha dati, scrivilo in una riga e vai avanti.

Data:
${JSON.stringify(data, null, 2)}`;

    return this.think(prompt);
  }

  // --- Tool definitions for Claude tool use ---
  private tools: Tool[] = [
    {
      name: "create_task",
      description: "Create a new task in the system and optionally assign it to an employee. Use this when the user asks to create a task, set a reminder, or assign work to someone.",
      input_schema: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: "Task title" },
          description: { type: "string", description: "Task description" },
          priority: { type: "string", enum: ["low", "medium", "high", "urgent"], description: "Task priority" },
          assigned_to_name: { type: "string", description: "Employee name to assign the task to (optional)" },
          due_date: { type: "string", description: "Due date in YYYY-MM-DD format (optional)" },
        },
        required: ["title"],
      },
    },
    {
      name: "send_slack_notification",
      description: "Send a message to a Slack channel. Use this to notify team members about tasks, reminders, or important updates.",
      input_schema: {
        type: "object" as const,
        properties: {
          message: { type: "string", description: "The message to send to Slack" },
          channel_id: { type: "string", description: "Slack channel ID (optional, uses default notifications channel if omitted)" },
        },
        required: ["message"],
      },
    },
    {
      name: "send_email",
      description: "Send an email to an employee or any address. Use this for reminders, notifications, or any email communication. Look up the employee's email from context if only a name is given.",
      input_schema: {
        type: "object" as const,
        properties: {
          to: { type: "string", description: "Recipient email address" },
          subject: { type: "string", description: "Email subject line" },
          body: { type: "string", description: "Email body text" },
        },
        required: ["to", "subject", "body"],
      },
    },
    {
      name: "update_task_status",
      description: "Update the status of an existing task. Use this when the user says a task is done, in progress, or cancelled.",
      input_schema: {
        type: "object" as const,
        properties: {
          task_title: { type: "string", description: "Title or partial title of the task to update" },
          new_status: { type: "string", enum: ["pending", "in_progress", "done", "cancelled"], description: "New status" },
        },
        required: ["task_title", "new_status"],
      },
    },
    {
      name: "generate_report_pdf",
      description: "Generate a PDF operations report. Supports daily, weekly, or employee-specific reports. The PDF will be sent as a file to the user.",
      input_schema: {
        type: "object" as const,
        properties: {
          type: { type: "string", enum: ["daily", "weekly", "employee"], description: "Report type" },
          employee_name: { type: "string", description: "Employee name (required for type=employee)" },
          start_date: { type: "string", description: "Start date YYYY-MM-DD (optional, for weekly range)" },
          end_date: { type: "string", description: "End date YYYY-MM-DD (optional)" },
        },
        required: ["type"],
      },
    },
    {
      name: "manage_team",
      description: "Manage team members and clients. Add new employees/clients or list existing ones.",
      input_schema: {
        type: "object" as const,
        properties: {
          action: { type: "string", enum: ["add_employee", "list_employees", "add_client", "list_clients"], description: "Action to perform" },
          name: { type: "string", description: "Name (for add actions)" },
          email: { type: "string", description: "Email address (optional)" },
          role: { type: "string", description: "Role (for employees)" },
          company: { type: "string", description: "Company (for clients)" },
        },
        required: ["action"],
      },
    },
    {
      name: "notion_action",
      description: "Interact with Notion workspace. Create tasks or search for pages/databases.",
      input_schema: {
        type: "object" as const,
        properties: {
          action: { type: "string", enum: ["create_task", "search"], description: "Action to perform" },
          query: { type: "string", description: "Search query (for search action)" },
          title: { type: "string", description: "Task title (for create_task)" },
          status: { type: "string", description: "Task status (optional)" },
          priority: { type: "string", description: "Task priority (optional)" },
          due_date: { type: "string", description: "Due date YYYY-MM-DD (optional)" },
        },
        required: ["action"],
      },
    },
    {
      name: "search_drive",
      description: "Search or list files in the COO Google Drive folder.",
      input_schema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Search query (optional; if omitted, lists recent files)" },
          max_results: { type: "number", description: "Max files to return (default 10)" },
        },
        required: [],
      },
    },
    {
      name: "get_report_history",
      description: "Retrieve past operations reports. Get recent reports or a specific report by date.",
      input_schema: {
        type: "object" as const,
        properties: {
          date: { type: "string", description: "Specific date YYYY-MM-DD (optional; if omitted, returns last 10 reports)" },
        },
        required: [],
      },
    },
    {
      name: "get_slack_summary",
      description: "Get an AI-generated summary of Slack conversations, organized by channel.",
      input_schema: {
        type: "object" as const,
        properties: {
          hours: { type: "number", description: "Hours to look back (default 24)" },
        },
        required: [],
      },
    },
    {
      name: "edit_task",
      description: "Edit an existing task's details (title, description, priority, due date, assignee) or delete it.",
      input_schema: {
        type: "object" as const,
        properties: {
          task_title: { type: "string", description: "Title or partial title of the task to find" },
          action: { type: "string", enum: ["edit", "delete"], description: "Edit or delete the task" },
          new_title: { type: "string", description: "New title (optional)" },
          new_description: { type: "string", description: "New description (optional)" },
          new_priority: { type: "string", enum: ["low", "medium", "high", "urgent"], description: "New priority (optional)" },
          new_due_date: { type: "string", description: "New due date YYYY-MM-DD (optional)" },
          new_assigned_to: { type: "string", description: "New assignee name (optional)" },
        },
        required: ["task_title", "action"],
      },
    },
    {
      name: "get_calendar_events",
      description: "Get calendar events for today. Use this when the user asks about their schedule or meetings.",
      input_schema: {
        type: "object" as const,
        properties: {
          date: { type: "string", description: "Date YYYY-MM-DD (default: today)" },
        },
        required: [],
      },
    },
    {
      name: "snooze_escalation",
      description: "Pause escalation notifications for a specific task. Use when the user says to stop escalating or snooze a task.",
      input_schema: {
        type: "object" as const,
        properties: {
          task_title: { type: "string", description: "Title or partial title of the task" },
          pause_days: { type: "number", description: "Number of days to pause escalation (default 3)" },
        },
        required: ["task_title"],
      },
    },
    {
      name: "create_recurring_task",
      description: "Create a recurring task template that generates new instances automatically. Use for daily standups, weekly reviews, etc.",
      input_schema: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: "Task title" },
          description: { type: "string", description: "Task description (optional)" },
          priority: { type: "string", enum: ["low", "medium", "high", "urgent"], description: "Priority" },
          assigned_to_name: { type: "string", description: "Employee name to assign (optional)" },
          pattern: { type: "string", enum: ["daily", "weekly", "monthly"], description: "Recurrence pattern" },
          days: { type: "string", description: "JSON array of days. For weekly: [1,3,5] = Mon/Wed/Fri. For monthly: [1,15] = 1st and 15th. Optional." },
          end_date: { type: "string", description: "End date YYYY-MM-DD (optional)" },
        },
        required: ["title", "pattern"],
      },
    },
    {
      name: "get_team_workload",
      description: "Get the workload summary for all team members. Shows tasks assigned, completed, overdue, and workload score.",
      input_schema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    {
      name: "set_task_dependency",
      description: "Set a dependency between tasks. Task B will be blocked until Task A is completed. Use when user says 'B depends on A' or 'do A before B'.",
      input_schema: {
        type: "object" as const,
        properties: {
          task_title: { type: "string", description: "Title of the task to block (the dependent one)" },
          depends_on_title: { type: "string", description: "Title of the task that must be completed first" },
        },
        required: ["task_title", "depends_on_title"],
      },
    },
    {
      name: "schedule_task",
      description: "Schedule a task into Google Calendar. Sets estimated duration and auto-schedules it in a free slot before the deadline.",
      input_schema: {
        type: "object" as const,
        properties: {
          task_title: { type: "string", description: "Title or partial title of the task" },
          duration_minutes: { type: "number", description: "Estimated duration in minutes (default 60)" },
        },
        required: ["task_title"],
      },
    },
    {
      name: "get_team_capacity",
      description: "Get team capacity forecast for the next 5 days. Shows utilization, available hours, and overload status for each employee.",
      input_schema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    {
      name: "suggest_assignment",
      description: "Suggest the best employee to assign a task to, based on current workload and availability.",
      input_schema: {
        type: "object" as const,
        properties: {
          estimated_minutes: { type: "number", description: "Estimated task duration in minutes (default 60)" },
        },
        required: [],
      },
    },
  ];

  // --- Execute a tool call ---
  private async executeTool(name: string, input: Record<string, any>): Promise<string> {
    try {
      if (name === "create_task") {
        let assignedTo: string | null = null;
        if (input.assigned_to_name) {
          const [emp] = await db.select().from(employees)
            .where(sql`${employees.name} ILIKE ${"%" + input.assigned_to_name + "%"}`).limit(1);
          assignedTo = emp?.id ?? null;
        }

        await db.insert(tasks).values({
          title: input.title,
          description: input.description ?? null,
          priority: input.priority ?? "medium",
          assignedTo,
          dueDate: input.due_date ? new Date(input.due_date) : null,
          source: "ai",
          status: "pending",
        });

        // Also notify on Slack if configured
        if (config.SLACK_NOTIFICATIONS_CHANNEL) {
          const assignee = input.assigned_to_name ? ` (assegnato a ${input.assigned_to_name})` : "";
          await sendSlackMessage(
            config.SLACK_NOTIFICATIONS_CHANNEL,
            `📋 Nuovo task: *${input.title}*${assignee} — Priority: ${input.priority ?? "medium"}`,
          ).catch(() => {});
        }

        return `Task "${input.title}" creato con successo${input.assigned_to_name ? ` e assegnato a ${input.assigned_to_name}` : ""}. ${config.SLACK_NOTIFICATIONS_CHANNEL ? "Notifica inviata su Slack." : ""}`;
      }

      if (name === "send_slack_notification") {
        const channelId = input.channel_id || config.SLACK_NOTIFICATIONS_CHANNEL;
        if (!channelId) return "Slack notifications channel non configurato. Imposta SLACK_NOTIFICATIONS_CHANNEL nel .env.";
        const sent = await sendSlackMessage(channelId, input.message);
        return sent ? "Messaggio inviato su Slack con successo." : "Invio fallito — controlla la configurazione Slack.";
      }

      if (name === "send_email") {
        const sent = await sendEmail(input.to, input.subject, input.body);
        return sent
          ? `Email inviata a ${input.to} con oggetto "${input.subject}".`
          : `Invio email fallito a ${input.to} — verifica la configurazione Google (serve il scope gmail.send).`;
      }

      if (name === "update_task_status") {
        const [task] = await db.select().from(tasks)
          .where(sql`${tasks.title} ILIKE ${"%" + input.task_title + "%"}`).limit(1);
        if (!task) return `Task "${input.task_title}" non trovato.`;
        await db.update(tasks).set({ status: input.new_status, updatedAt: new Date() }).where(eq(tasks.id, task.id));

        // Check if completing this task unblocks others
        let unblockMsg = "";
        if (input.new_status === "done" || input.new_status === "cancelled") {
          const blocked = await db.select().from(tasks)
            .where(sql`${tasks.blockedBy} LIKE ${"%" + task.id + "%"}`);
          for (const bt of blocked) {
            const deps: string[] = bt.blockedBy ? JSON.parse(bt.blockedBy) : [];
            const remaining = deps.filter((d) => d !== task.id);
            if (remaining.length === 0) {
              // Fully unblocked
              await db.update(tasks).set({ blockedBy: null, updatedAt: new Date() }).where(eq(tasks.id, bt.id));
              unblockMsg += `\n\uD83D\uDD13 Task "${bt.title}" sbloccato!`;
            } else {
              await db.update(tasks).set({ blockedBy: JSON.stringify(remaining), updatedAt: new Date() }).where(eq(tasks.id, bt.id));
            }
          }
        }

        return `Task "${task.title}" aggiornato a ${input.new_status}.${unblockMsg}`;
      }

      if (name === "generate_report_pdf") {
        const reportType = input.type as string;

        if (reportType === "employee") {
          if (!input.employee_name) return "Nome employee richiesto per il report employee.";
          const now = new Date();
          const weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate() - 7);
          const pdf = await generateEmployeeReportPdf(input.employee_name, weekAgo, now);
          const fileName = `employee-${input.employee_name.toLowerCase()}-${now.toISOString().split("T")[0]}.pdf`;
          const driveFile = await uploadFileToDrive(fileName, pdf, "application/pdf", config.DRIVE_EMPLOYEE_FOLDER_ID || undefined).catch(() => null);
          this.collectedFiles.push({ buffer: pdf, filename: fileName });
          return `Report PDF per ${input.employee_name} generato.${driveFile ? ` Salvato su Drive: ${driveFile.webViewLink}` : ""}`;
        }

        if (reportType === "weekly") {
          const now = new Date();
          const start = input.start_date ? new Date(input.start_date) : (() => { const d = new Date(now); d.setDate(d.getDate() - (d.getDay() === 0 ? 6 : d.getDay() - 1)); d.setHours(0,0,0,0); return d; })();
          const end = input.end_date ? new Date(input.end_date) : now;
          const pdf = await generateWeeklyReportPdf(start, end);
          const fileName = `weekly-report-${start.toISOString().split("T")[0]}.pdf`;
          const driveFile = await uploadFileToDrive(fileName, pdf, "application/pdf", config.DRIVE_DAILY_FOLDER_ID || undefined).catch(() => null);
          this.collectedFiles.push({ buffer: pdf, filename: fileName });
          return `Report PDF settimanale generato.${driveFile ? ` Salvato su Drive: ${driveFile.webViewLink}` : ""}`;
        }

        // daily
        const today = new Date().toISOString().split("T")[0];
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
        const notionData = isNotionConfigured() ? await getNotionWorkspaceSummary().catch(() => null) : null;

        const narrative = await this.think("Genera un report operativo giornaliero basato sui dati forniti. Scrivi in modo narrativo. Per il PDF: NON usare emoji, usa solo testo ASCII.", {
          date: today,
          calendar_events: calEvts.map((e) => ({ summary: e.summary, start: e.start, end: e.end })),
          important_emails: emails.map((e) => ({ from: e.from, subject: e.subject, snippet: e.snippet })),
          tasks: activeTasks.map((t) => ({ title: t.title, status: t.status, priority: t.priority, due: t.dueDate })),
          slack_messages: slackMsgs.length,
        });

        const srcCount = new Map<string, number>();
        for (const m of allMsgs) srcCount.set(m.source, (srcCount.get(m.source) ?? 0) + 1);
        const srcColors: Record<string, string> = { slack: "#611f69", telegram: "#0088cc", gmail: "#ea4335" };

        const pdf = await generateDailyReportPdf({
          narrative, date: today,
          taskCount: activeTasks.length, overdueCount: overdueTasks.length, doneCount: doneTasks.length,
          slackMsgCount: slackMsgs.length, emailCount: emails.length, calendarCount: calEvts.length,
          notionTaskCount: notionData?.tasks.length ?? 0,
          taskList: activeTasks.map((t) => ({ title: t.title, status: t.status, priority: t.priority, due: t.dueDate })),
          msgBySource: Array.from(srcCount, ([s, v]) => ({ label: s, value: v, color: srcColors[s] ?? "#888888" })),
        });
        const fileName = `daily-report-${today}.pdf`;
        const driveFile = await uploadFileToDrive(fileName, pdf, "application/pdf", config.DRIVE_DAILY_FOLDER_ID || undefined).catch(() => null);
        this.collectedFiles.push({ buffer: pdf, filename: fileName });
        await db.insert(dailyReports).values({ reportDate: today, reportType: "on_demand", content: narrative });
        return `Report PDF giornaliero generato.${driveFile ? ` Salvato su Drive: ${driveFile.webViewLink}` : ""}`;
      }

      if (name === "manage_team") {
        const action = input.action as string;
        if (action === "list_employees") {
          const allEmps = await db.select().from(employees).where(eq(employees.isActive, true));
          if (!allEmps.length) return "Nessun employee attivo nel sistema.";
          return allEmps.map((e) => `- ${e.name} (${e.role ?? "no role"}) — ${e.email ?? "no email"}`).join("\n");
        }
        if (action === "list_clients") {
          const allClients = await db.select().from(clients).where(eq(clients.isActive, true));
          if (!allClients.length) return "Nessun client attivo nel sistema.";
          return allClients.map((c) => `- ${c.name} — ${c.company ?? "no company"} (${c.email ?? "no email"})`).join("\n");
        }
        if (action === "add_employee") {
          if (!input.name) return "Nome richiesto per aggiungere un employee.";
          await db.insert(employees).values({ name: input.name, email: input.email ?? null, role: input.role ?? null });
          return `Employee "${input.name}" aggiunto con successo.${input.role ? ` Ruolo: ${input.role}.` : ""}`;
        }
        if (action === "add_client") {
          if (!input.name) return "Nome richiesto per aggiungere un client.";
          await db.insert(clients).values({ name: input.name, company: input.company ?? null, email: input.email ?? null });
          return `Client "${input.name}" aggiunto con successo.${input.company ? ` Azienda: ${input.company}.` : ""}`;
        }
        return `Azione "${action}" non riconosciuta.`;
      }

      if (name === "notion_action") {
        const action = input.action as string;
        if (action === "search") {
          if (!input.query) return "Query di ricerca richiesta.";
          const results = await searchNotion(input.query);
          if (!results.length) return `Nessun risultato trovato per "${input.query}" su Notion.`;
          return results.map((r) => `- [${r.type}] ${r.title} — ${r.url}`).join("\n");
        }
        if (action === "create_task") {
          if (!input.title) return "Titolo richiesto per creare un task su Notion.";
          const url = await createNotionTask(input.title, {
            status: input.status, priority: input.priority, dueDate: input.due_date,
          });
          return url ? `Task Notion "${input.title}" creato: ${url}` : "Creazione task Notion fallita — verifica la configurazione.";
        }
        return `Azione Notion "${action}" non riconosciuta.`;
      }

      if (name === "search_drive") {
        const maxResults = input.max_results ?? 10;
        const files = input.query
          ? await searchDriveFiles(input.query, maxResults)
          : await listDriveFiles(maxResults);
        if (!files.length) return input.query ? `Nessun file trovato per "${input.query}" su Drive.` : "Nessun file nella cartella COO Drive.";
        return files.map((f) => `- ${f.name} (${f.createdTime ? new Date(f.createdTime).toLocaleDateString("it-IT") : ""}) — ${f.webViewLink}`).join("\n");
      }

      if (name === "get_report_history") {
        if (input.date) {
          const [report] = await db.select().from(dailyReports)
            .where(eq(dailyReports.reportDate, input.date)).limit(1);
          if (!report) return `Nessun report trovato per il ${input.date}.`;
          return `Report del ${report.reportDate} (${report.reportType}):\n\n${report.content}`;
        }
        const reports = await db.select().from(dailyReports).orderBy(desc(dailyReports.createdAt)).limit(10);
        if (!reports.length) return "Nessun report nello storico.";
        return "Ultimi report:\n" + reports.map((r) => `- ${r.reportDate} [${r.reportType}]: ${r.content.slice(0, 100)}...`).join("\n");
      }

      if (name === "get_slack_summary") {
        const hours = input.hours ?? 24;
        const cutoff = new Date(); cutoff.setHours(cutoff.getHours() - hours);
        const msgs = await db.select().from(messageLogs)
          .where(and(eq(messageLogs.source, "slack"), gte(messageLogs.receivedAt, cutoff)));
        if (!msgs.length) return `Nessun messaggio Slack nelle ultime ${hours} ore.`;

        const byChannel = new Map<string, string[]>();
        for (const m of msgs) {
          const ch = m.chatTitle ?? "unknown";
          if (!byChannel.has(ch)) byChannel.set(ch, []);
          byChannel.get(ch)!.push(`${m.senderName}: ${m.content.slice(0, 200)}`);
        }

        const digest = Array.from(byChannel, ([ch, messages]) =>
          `#${ch} (${messages.length} messaggi):\n${messages.slice(-10).join("\n")}`,
        ).join("\n\n");

        const summary = await this.think(
          "Riassumi le conversazioni Slack per canale. Evidenzia decisioni prese, azioni richieste, e temi principali. Sii conciso.",
          { slack_digest: digest, total_messages: msgs.length, channels: byChannel.size },
        );
        return summary;
      }

      if (name === "edit_task") {
        const matchingTasks = await db.select().from(tasks)
          .where(sql`${tasks.title} ILIKE ${"%" + input.task_title + "%"}`).limit(5);
        if (!matchingTasks.length) return `Task "${input.task_title}" non trovato.`;
        if (matchingTasks.length > 1 && input.action === "edit") {
          return `Trovati ${matchingTasks.length} task corrispondenti:\n${matchingTasks.map((t) => `- "${t.title}" (${t.status})`).join("\n")}\nSpecifica meglio il titolo.`;
        }
        const task = matchingTasks[0];

        if (input.action === "delete") {
          await db.delete(tasks).where(eq(tasks.id, task.id));
          return `Task "${task.title}" eliminato.`;
        }

        const updates: Record<string, any> = { updatedAt: new Date() };
        if (input.new_title) updates.title = input.new_title;
        if (input.new_description) updates.description = input.new_description;
        if (input.new_priority) updates.priority = input.new_priority;
        if (input.new_due_date) updates.dueDate = new Date(input.new_due_date);
        if (input.new_assigned_to) {
          const [emp] = await db.select().from(employees)
            .where(sql`${employees.name} ILIKE ${"%" + input.new_assigned_to + "%"}`).limit(1);
          if (emp) updates.assignedTo = emp.id;
          else return `Employee "${input.new_assigned_to}" non trovato. Task non modificato.`;
        }
        await db.update(tasks).set(updates).where(eq(tasks.id, task.id));
        return `Task "${task.title}" aggiornato con successo.`;
      }

      if (name === "get_calendar_events") {
        const events = await getTodayEvents();
        if (!events.length) return "Nessun evento in calendario per oggi.";
        return events.map((e) => {
          const start = e.start ? new Date(e.start).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }) : "TBD";
          const end = e.end ? new Date(e.end).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }) : "";
          return `- ${start}${end ? `-${end}` : ""}: ${e.summary}${e.location ? ` (${e.location})` : ""}`;
        }).join("\n");
      }

      if (name === "snooze_escalation") {
        const [task] = await db.select().from(tasks)
          .where(sql`${tasks.title} ILIKE ${"%" + input.task_title + "%"}`).limit(1);
        if (!task) return `Task "${input.task_title}" non trovato.`;
        const pauseDays = input.pause_days ?? 3;
        const pauseUntil = new Date();
        pauseUntil.setDate(pauseUntil.getDate() + pauseDays);
        await db.update(tasks).set({ escalationPausedUntil: pauseUntil, updatedAt: new Date() }).where(eq(tasks.id, task.id));
        return `Escalation per "${task.title}" in pausa fino al ${pauseUntil.toLocaleDateString("it-IT")}.`;
      }

      if (name === "create_recurring_task") {
        let assignedTo: string | null = null;
        if (input.assigned_to_name) {
          const [emp] = await db.select().from(employees)
            .where(sql`${employees.name} ILIKE ${"%" + input.assigned_to_name + "%"}`).limit(1);
          assignedTo = emp?.id ?? null;
        }

        await db.insert(tasks).values({
          title: input.title,
          description: input.description ?? null,
          priority: input.priority ?? "medium",
          assignedTo,
          isRecurring: true,
          recurrencePattern: input.pattern,
          recurrenceDays: input.days ?? null,
          recurrenceEndDate: input.end_date ? new Date(input.end_date) : null,
          source: "ai",
          status: "pending",
        });

        return `Task ricorrente "${input.title}" creato (${input.pattern}${input.days ? `, giorni: ${input.days}` : ""}).${input.assigned_to_name ? ` Assegnato a ${input.assigned_to_name}.` : ""}`;
      }

      if (name === "get_team_workload") {
        const workload = await getTeamWorkload();
        if (!workload.length) return "Nessun employee attivo nel sistema.";
        return workload.map((w) => {
          const bar = w.workloadScore >= 0.7 ? "\uD83D\uDD34" : w.workloadScore >= 0.4 ? "\uD83D\uDFE1" : "\uD83D\uDFE2";
          return `${bar} ${w.employeeName}: ${w.tasksAssigned} assegnati, ${w.tasksCompleted} completati oggi, ${w.tasksOverdue} overdue — score: ${(w.workloadScore * 100).toFixed(0)}%`;
        }).join("\n");
      }

      if (name === "set_task_dependency") {
        const [dependent] = await db.select().from(tasks)
          .where(sql`${tasks.title} ILIKE ${"%" + input.task_title + "%"}`).limit(1);
        if (!dependent) return `Task "${input.task_title}" non trovato.`;

        const [blocker] = await db.select().from(tasks)
          .where(sql`${tasks.title} ILIKE ${"%" + input.depends_on_title + "%"}`).limit(1);
        if (!blocker) return `Task "${input.depends_on_title}" non trovato.`;

        const existingDeps: string[] = dependent.blockedBy ? JSON.parse(dependent.blockedBy) : [];
        if (!existingDeps.includes(blocker.id)) existingDeps.push(blocker.id);

        await db.update(tasks)
          .set({ blockedBy: JSON.stringify(existingDeps), updatedAt: new Date() })
          .where(eq(tasks.id, dependent.id));

        return `Dipendenza impostata: "${dependent.title}" e' ora bloccato da "${blocker.title}". Si sblocchera' quando "${blocker.title}" viene completato.`;
      }

      if (name === "schedule_task") {
        const [task] = await db.select().from(tasks)
          .where(sql`${tasks.title} ILIKE ${"%" + input.task_title + "%"}`).limit(1);
        if (!task) return `Task "${input.task_title}" non trovato.`;

        const duration = input.duration_minutes ?? 60;
        await db.update(tasks)
          .set({ estimatedMinutes: duration, autoScheduled: false, updatedAt: new Date() })
          .where(eq(tasks.id, task.id));

        return `Task "${task.title}" pronto per auto-scheduling (durata: ${duration} min). Verra' piazzato nel prossimo ciclo di scheduling o puoi attendere il prossimo check automatico.`;
      }

      if (name === "get_team_capacity") {
        const capacity = await getTeamCapacity();
        if (!capacity.length) return "Nessun employee attivo nel sistema.";
        return capacity.map((c) => {
          const icon = c.status === "overloaded" ? "\uD83D\uDD34" : c.status === "balanced" ? "\uD83D\uDFE1" : "\uD83D\uDFE2";
          return `${icon} ${c.employeeName} (${c.role ?? "no role"}): ${c.utilizationPercent}% utilizzo — ${c.scheduledHours}h schedulate, ${c.availableHours}h libere — ${c.taskCount} task (${c.overdueCount} overdue)`;
        }).join("\n");
      }

      if (name === "suggest_assignment") {
        const minutes = input.estimated_minutes ?? 60;
        return suggestAssignment(minutes);
      }

      return `Tool "${name}" non riconosciuto.`;
    } catch (err: any) {
      logger.error({ err, tool: name }, "Tool execution failed");
      return `Errore nell'esecuzione: ${err.message}`;
    }
  }

  async answerQuery(query: string): Promise<AgentResponse> {
    this.collectedFiles = [];
    const [allEmployees, allClients, activeTasks] = await Promise.all([
      db.select().from(employees).where(eq(employees.isActive, true)),
      db.select().from(clients).where(eq(clients.isActive, true)),
      db.select().from(tasks).where(inArray(tasks.status, ["pending", "in_progress"])),
    ]);

    const [calendarEvents, importantEmails, notionData, driveFiles] = await Promise.all([
      getTodayEvents().catch(() => []),
      getUnreadImportantEmails(5).catch(() => []),
      isNotionConfigured() ? getNotionWorkspaceSummary().catch(() => null) : Promise.resolve(null),
      listDriveFiles(10).catch(() => []),
    ]);

    const recentSlackMessages = await db.select().from(messageLogs)
      .where(and(eq(messageLogs.source, "slack"), sql`${messageLogs.receivedAt} > now() - interval '24 hours'`));

    const dateRange = parseDateKeywords(query);
    const employeeMatch = await findEmployeeInQuery(query);

    let historicalData: Record<string, unknown> | null = null;
    let employeeActivity: Record<string, unknown> | null = null;

    if (dateRange) historicalData = await getActivityByDateRange(dateRange).catch(() => null);
    if (employeeMatch && dateRange) {
      employeeActivity = await getEmployeeActivity(employeeMatch.id, dateRange).catch(() => null);
    } else if (employeeMatch) {
      const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);
      employeeActivity = await getEmployeeActivity(employeeMatch.id, { start: weekAgo, end: new Date() }).catch(() => null);
    }

    const context: Record<string, unknown> = {
      today: new Date().toISOString().split("T")[0],
      employees: allEmployees.map((e) => ({ id: e.id, name: e.name, role: e.role })),
      clients: allClients.map((c) => ({ id: c.id, name: c.name, company: c.company })),
      active_tasks: activeTasks.map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, due: t.dueDate })),
      calendar_events_today: calendarEvents.map((e) => ({ summary: e.summary, start: e.start, end: e.end, location: e.location })),
      unread_important_emails: importantEmails.map((e) => ({ from: e.from, subject: e.subject, snippet: e.snippet })),
      recent_slack_messages: recentSlackMessages.map((m) => ({ channel: m.chatTitle, sender: m.senderName, urgency: m.urgency, summary: m.content.slice(0, 200), received: m.receivedAt })),
      notion_tasks: notionData?.tasks.map((t) => ({ title: t.title, status: t.status, priority: t.priority, assignee: t.assignee, due: t.dueDate, overdue: t.isOverdue })) ?? [],
      notion_projects: notionData?.projects.map((p) => ({ name: p.name, status: p.status, owner: p.owner })) ?? [],
      drive_files: driveFiles.map((f) => ({ name: f.name, link: f.webViewLink, created: f.createdTime })),
      slack_notifications_configured: !!config.SLACK_NOTIFICATIONS_CHANNEL,
    };
    if (historicalData) context.historical_data = historicalData;
    if (employeeActivity) context.employee_activity = employeeActivity;

    // --- Tool use loop ---
    const contextStr = `Context:\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\`\n\n${query}`;

    let messages: any[] = [{ role: "user", content: contextStr }];
    let textParts: string[] = [];

    for (let i = 0; i < 5; i++) { // max 5 tool call rounds
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: COO_SYSTEM_PROMPT,
        tools: this.tools,
        messages,
      });

      // Collect text blocks and tool use blocks
      const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
      const textBlocks = response.content.filter((b) => b.type === "text");

      for (const tb of textBlocks) {
        if (tb.type === "text") textParts.push(tb.text);
      }

      if (response.stop_reason === "end_turn" || !toolUseBlocks.length) {
        break;
      }

      // Execute tools and continue conversation
      const toolResults: ToolResultBlockParam[] = [];
      for (const block of toolUseBlocks) {
        if (block.type === "tool_use") {
          logger.info({ tool: block.name, input: block.input }, "AI executing tool");
          const result = await this.executeTool(block.name, block.input as Record<string, any>);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
        }
      }

      messages = [
        ...messages,
        { role: "assistant", content: response.content },
        { role: "user", content: toolResults },
      ];
    }

    return {
      text: textParts.join("\n") || "Operazione completata.",
      files: this.collectedFiles.length ? this.collectedFiles : undefined,
    };
  }

  async generateEmployeeNarrative(
    employeeName: string,
    data: Record<string, unknown>,
  ): Promise<string> {
    const prompt = `Genera un report operativo dettagliato per ${employeeName}.
Scrivi in modo narrativo e professionale, come un COO che presenta il resoconto al founder.

Struttura il report con queste sezioni (usa esattamente questi titoli):

SOMMARIO ESECUTIVO
Panoramica in 3-4 righe dello stato dell'employee.

ATTIVITA COMPLETATE
Cosa ha fatto, task chiusi, risultati concreti.

TASK IN CORSO
Su cosa sta lavorando, stato avanzamento.

TASK OVERDUE O BLOCCATI
Cosa e' in ritardo. Se non ci sono, scrivi "Nessun task in ritardo."

COMUNICAZIONE
Riassunto messaggi Slack/Telegram, temi discussi, decisioni prese.

NOTION
Stato task su Notion, aggiornamenti recenti.

PRODUTTIVITA
Valutazione basata sui dati: task ratio completati/assegnati, volume messaggi, reattivita.

RACCOMANDAZIONI
Suggerimenti concreti per migliorare.

Usa dati concreti: numeri, date, nomi dei task. Non inventare dati che non sono nel context.
Se una sezione non ha dati, scrivilo brevemente e vai avanti.`;

    return this.think(prompt, data);
  }
}

export const agent = new COOAgent();
