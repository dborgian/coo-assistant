import Anthropic from "@anthropic-ai/sdk";
import { and, eq, inArray, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../models/database.js";
import { clients, employees, messageLogs, tasks } from "../models/schema.js";
import { logger } from "../utils/logger.js";
import { getTodayEvents } from "../services/calendar-sync.js";
import { getUnreadImportantEmails } from "../services/email-manager.js";
import { getNotionWorkspaceSummary, isNotionConfigured } from "../services/notion-sync.js";
import { parseDateKeywords, findEmployeeInQuery, getActivityByDateRange, getEmployeeActivity } from "../services/history-query.js";
import { listDriveFiles } from "../services/drive-manager.js";
import { sendSlackMessage } from "../bot/slack-monitor.js";
import { sendEmail } from "../services/email-manager.js";
import type { Tool, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages.js";

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
- Inviare notifiche/messaggi su Slack (send_slack_notification)
- Aggiornare lo status di un task (update_task_status)
- Inviare email di reminder o notifica (send_email)
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
        return `Task "${task.title}" aggiornato a ${input.new_status}.`;
      }

      return `Tool "${name}" non riconosciuto.`;
    } catch (err: any) {
      logger.error({ err, tool: name }, "Tool execution failed");
      return `Errore nell'esecuzione: ${err.message}`;
    }
  }

  async answerQuery(query: string): Promise<string> {
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

    return textParts.join("\n") || "Operazione completata.";
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
