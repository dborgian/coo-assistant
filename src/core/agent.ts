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
import { getAuthForEmployee } from "./google-auth.js";
import type { GoogleAuth } from "./google-auth.js";
import { generateDailyReportPdf, generateEmployeeReportPdf, generateWeeklyReportPdf, type DailyReportData } from "../services/pdf-generator.js";
import { sendSlackMessage } from "../bot/slack-monitor.js";
import { getTeamWorkload } from "../services/workload-tracker.js";
import { getTeamCapacity, suggestAssignment } from "../services/capacity-planner.js";
import { rescheduleTask, unscheduleTask } from "../services/auto-scheduler.js";
import { deleteCalendarEvent } from "../services/calendar-sync.js";
import { createGoogleTask, completeGoogleTask, updateGoogleTask, deleteGoogleTask } from "../services/google-tasks-sync.js";
import { getProjectETA } from "../services/project-eta.js";
import { addNotionComment, createNotionProject, updateNotionTaskProperties } from "../services/notion-sync.js";
import { getCommitments } from "../services/commitment-tracker.js";
import { getTeamSentiment } from "../services/sentiment-analyzer.js";
import { getCommunicationOverview } from "../services/communication-patterns.js";
import { queryKnowledge } from "../services/knowledge-base.js";
import { getTopics, getClientMentions } from "../services/topic-analyzer.js";
import { getMeetingStats } from "../services/meeting-intelligence.js";
import type { Tool, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages.js";
import type { AccessRole } from "../bot/auth.js";
import { getAllowedToolNames } from "../bot/permissions.js";

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
- Vedere promesse/commitment del team e se sono stati mantenuti (get_commitments)
- Analizzare il morale e sentiment del team (get_team_sentiment)
- Vedere pattern di comunicazione, tempi di risposta, employee silenziosi (get_communication_patterns)
- Consultare la knowledge base aziendale (query_knowledge_base)
- Vedere trending topics e clienti piu' discussi (get_topics)
- Statistiche meeting e overload (get_meeting_intelligence)
- Aggiungere commenti/note ai task su Notion (add_notion_comment)
- Creare progetti su Notion (create_notion_project)

SYNC NOTION BIDIREZIONALE:
- Task creati qui appaiono su Notion entro 1 minuto
- Task completati/cancellati qui aggiornano lo status su Notion
- Task creati su Notion vengono importati qui automaticamente
- Cambi di priorita/deadline si sincronizzano in entrambe le direzioni
- Puoi aggiungere note ai task che saranno visibili su Notion

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

/**
 * Parse a date string respecting the configured timezone.
 * Accepts: "2026-03-26", "2026-03-26T16:00", "2026-03-26T16:00:00"
 * If no time is provided, defaults to 23:59 local time (end of day).
 */
function parseLocalDate(dateStr: string): Date {
  const tz = config.TIMEZONE || "Europe/Rome";

  if (dateStr.includes("T")) {
    // Has time component — parse as local datetime
    const date = new Date(dateStr);
    if (!isNaN(date.getTime())) {
      // Interpret as local time in the configured timezone
      const localStr = date.toLocaleString("en-US", { timeZone: tz });
      const utcStr = date.toLocaleString("en-US", { timeZone: "UTC" });
      const diff = new Date(utcStr).getTime() - new Date(localStr).getTime();
      // dateStr is intended as local time, so we need to add the offset
      const parts = dateStr.split("T");
      const [year, month, day] = parts[0].split("-").map(Number);
      const timeParts = parts[1].split(":").map(Number);
      const hour = timeParts[0] ?? 0;
      const minute = timeParts[1] ?? 0;
      // Create date in UTC then adjust for timezone
      const localDate = new Date(Date.UTC(year, month - 1, day, hour, minute));
      // Get the offset for this specific date in the target timezone
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        timeZoneName: "shortOffset",
      });
      const formatted = formatter.format(localDate);
      const offsetMatch = formatted.match(/GMT([+-]\d+(?::\d+)?)/);
      let offsetMs = 0;
      if (offsetMatch) {
        const [h, m] = (offsetMatch[1] + ":0").split(":").map(Number);
        offsetMs = (h * 60 + (h < 0 ? -m : m)) * 60 * 1000;
      }
      return new Date(localDate.getTime() - offsetMs);
    }
  }

  // Date only — set to end of day in local timezone
  const [year, month, day] = dateStr.split("-").map(Number);
  if (!year || !month || !day) return new Date(dateStr);

  const endOfDay = new Date(Date.UTC(year, month - 1, day, 23, 59, 0));
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "shortOffset",
  });
  const formatted = formatter.format(endOfDay);
  const offsetMatch = formatted.match(/GMT([+-]\d+(?::\d+)?)/);
  let offsetMs = 0;
  if (offsetMatch) {
    const [h, m] = (offsetMatch[1] + ":0").split(":").map(Number);
    offsetMs = (h * 60 + (h < 0 ? -m : m)) * 60 * 1000;
  }
  return new Date(endOfDay.getTime() - offsetMs);
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
          due_date: { type: "string", description: "Due date in YYYY-MM-DD or YYYY-MM-DDTHH:mm format (e.g. 2026-03-26T16:00). Always include time if the user specifies it." },
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
          new_due_date: { type: "string", description: "New due date YYYY-MM-DD or YYYY-MM-DDTHH:mm (optional)" },
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
    {
      name: "get_commitments",
      description: "Get commitments/promises made by team members in conversations. Shows who promised what and if they followed through.",
      input_schema: {
        type: "object" as const,
        properties: {
          employee_name: { type: "string", description: "Filter by employee name (optional)" },
          status: { type: "string", enum: ["open", "fulfilled", "broken", "all"], description: "Filter by status (default: open)" },
          days: { type: "number", description: "Look back N days (default 7)" },
        },
        required: [],
      },
    },
    {
      name: "get_team_sentiment",
      description: "Get team morale and sentiment analysis. Shows mood scores, labels, and trends per employee.",
      input_schema: {
        type: "object" as const,
        properties: {
          employee_name: { type: "string", description: "Filter by employee (optional)" },
          days: { type: "number", description: "Look back N days (default 7)" },
        },
        required: [],
      },
    },
    {
      name: "get_communication_patterns",
      description: "Get communication patterns: message counts, response times, active hours, silent employees.",
      input_schema: {
        type: "object" as const,
        properties: {
          employee_name: { type: "string", description: "Filter by employee (optional)" },
          days: { type: "number", description: "Look back N days (default 7)" },
        },
        required: [],
      },
    },
    {
      name: "query_knowledge_base",
      description: "Search the company knowledge base. Accumulated facts about clients, processes, team, lessons learned from conversations.",
      input_schema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "What to search for" },
          category: { type: "string", enum: ["client", "process", "technical", "team", "lesson", "all"], description: "Knowledge category (optional)" },
        },
        required: ["query"],
      },
    },
    {
      name: "get_topics",
      description: "Get trending topics, most-discussed clients, and conversation themes.",
      input_schema: {
        type: "object" as const,
        properties: {
          type: { type: "string", enum: ["topics", "clients", "all"], description: "What to analyze (default: all)" },
          days: { type: "number", description: "Look back N days (default 7)" },
        },
        required: [],
      },
    },
    {
      name: "get_meeting_intelligence",
      description: "Get meeting statistics: today's meetings, total hours, free time, overload detection.",
      input_schema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    {
      name: "add_notion_comment",
      description: "Add a comment/note to a task on Notion. Use when user says 'aggiungi nota al task X'.",
      input_schema: {
        type: "object" as const,
        properties: {
          task_title: { type: "string", description: "Title of the task to comment on" },
          comment: { type: "string", description: "The comment/note text" },
        },
        required: ["task_title", "comment"],
      },
    },
    {
      name: "create_notion_project",
      description: "Create a new project in the Notion Projects database.",
      input_schema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Project name" },
          status: { type: "string", description: "Project status (optional)" },
        },
        required: ["name"],
      },
    },
    {
      name: "get_project_eta",
      description: "Get estimated completion date for a project. Calculates velocity, remaining work, and confidence level.",
      input_schema: {
        type: "object" as const,
        properties: {
          project_name: { type: "string", description: "Project name or keyword to match related tasks" },
        },
        required: ["project_name"],
      },
    },
    {
      name: "create_project_from_description",
      description: "Auto-create a project with multiple tasks from a description. AI generates tasks, estimates, and assignments. Use when user says 'crea progetto X' with details.",
      input_schema: {
        type: "object" as const,
        properties: {
          description: { type: "string", description: "Project description with goals and requirements" },
          deadline: { type: "string", description: "Overall project deadline YYYY-MM-DD (optional)" },
        },
        required: ["description"],
      },
    },
    {
      name: "delete_calendar_event",
      description: "Delete/cancel a calendar event. Use when user wants to remove a meeting or event from the calendar. Can search by name if no ID is provided.",
      input_schema: {
        type: "object" as const,
        properties: {
          event_id: { type: "string", description: "Google Calendar event ID (if known)" },
          event_summary: { type: "string", description: "Event title/name to search for and delete" },
        },
        required: [],
      },
    },
    {
      name: "unschedule_task",
      description: "Remove a task's scheduled calendar event. The task stays active but is no longer on the calendar. Use when user wants to deschedule/unschedule a task.",
      input_schema: {
        type: "object" as const,
        properties: {
          task_title: { type: "string", description: "Task title or keyword to match" },
        },
        required: ["task_title"],
      },
    },
  ];

  // --- Execute a tool call ---
  private async executeTool(name: string, input: Record<string, any>, userAuth?: GoogleAuth | null): Promise<string> {
    try {
      if (name === "create_task") {
        let assignedTo: string | null = null;
        if (input.assigned_to_name) {
          const [emp] = await db.select().from(employees)
            .where(sql`${employees.name} ILIKE ${"%" + input.assigned_to_name + "%"}`).limit(1);
          assignedTo = emp?.id ?? null;
        }

        const [newTask] = await db.insert(tasks).values({
          title: input.title,
          description: input.description ?? null,
          priority: input.priority ?? "medium",
          assignedTo,
          dueDate: input.due_date ? parseLocalDate(input.due_date) : null,
          source: "ai",
          status: "pending",
        }).returning({ id: tasks.id });

        // Sync to Google Tasks
        if (newTask) {
          createGoogleTask(newTask.id).catch(() => {});
        }

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
        const sent = await sendEmail(input.to, input.subject, input.body, userAuth);
        return sent
          ? `Email inviata a ${input.to} con oggetto "${input.subject}".`
          : `Invio email fallito a ${input.to} — verifica la configurazione Google (serve il scope gmail.send).`;
      }

      if (name === "update_task_status") {
        const [task] = await db.select().from(tasks)
          .where(sql`${tasks.title} ILIKE ${"%" + input.task_title + "%"}`).limit(1);
        if (!task) return `Task "${input.task_title}" non trovato.`;
        await db.update(tasks).set({ status: input.new_status, updatedAt: new Date() }).where(eq(tasks.id, task.id));

        // Sync status to Google Tasks
        if (input.new_status === "done" || input.new_status === "cancelled") {
          completeGoogleTask(task.id).catch(() => {});
        }

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
          ? await searchDriveFiles(input.query, maxResults, userAuth)
          : await listDriveFiles(maxResults, userAuth);
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
          deleteGoogleTask(task.id).catch(() => {});
          await db.delete(tasks).where(eq(tasks.id, task.id));
          return `Task "${task.title}" eliminato.`;
        }

        const updates: Record<string, any> = { updatedAt: new Date() };
        if (input.new_title) updates.title = input.new_title;
        if (input.new_description) updates.description = input.new_description;
        if (input.new_priority) updates.priority = input.new_priority;
        if (input.new_due_date) updates.dueDate = parseLocalDate(input.new_due_date);
        if (input.new_assigned_to) {
          const [emp] = await db.select().from(employees)
            .where(sql`${employees.name} ILIKE ${"%" + input.new_assigned_to + "%"}`).limit(1);
          if (emp) updates.assignedTo = emp.id;
          else return `Employee "${input.new_assigned_to}" non trovato. Task non modificato.`;
        }
        await db.update(tasks).set(updates).where(eq(tasks.id, task.id));
        // Sync changes to Google Tasks
        if (input.new_title || input.new_description || input.new_due_date) {
          updateGoogleTask(task.id, {
            title: input.new_title,
            description: input.new_description,
            dueDate: input.new_due_date ? parseLocalDate(input.new_due_date) : undefined,
          }).catch(() => {});
        }
        // Trigger reschedule if priority or deadline changed and task was scheduled
        if ((input.new_priority || input.new_due_date) && task.autoScheduled) {
          await rescheduleTask(task.id).catch(() => {});
        }
        return `Task "${task.title}" aggiornato con successo.${task.autoScheduled && (input.new_priority || input.new_due_date) ? " Il task verra' rischedulato nel calendario." : ""}`;
      }

      if (name === "get_calendar_events") {
        const events = await getTodayEvents(userAuth);
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
          recurrenceEndDate: input.end_date ? parseLocalDate(input.end_date) : null,
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
        if (!task.dueDate) return `Task "${task.title}" non ha una scadenza. Imposta una scadenza prima di schedulare.`;

        const duration = input.duration_minutes ?? 60;
        await db.update(tasks)
          .set({ estimatedMinutes: duration, autoScheduled: false, updatedAt: new Date() })
          .where(eq(tasks.id, task.id));

        // Schedule immediately — find free slot and create calendar event
        try {
          const { google } = await import("googleapis");
          const { getGoogleAuth } = await import("../core/google-auth.js");
          const auth = getGoogleAuth();
          if (!auth) return `Task aggiornato ma Google Calendar non configurato.`;

          // Resolve calendar ID from assignee
          let calendarId = "primary";
          if (task.assignedTo) {
            const [emp] = await db.select({ googleEmail: employees.googleEmail, email: employees.email })
              .from(employees).where(eq(employees.id, task.assignedTo)).limit(1);
            if (emp?.googleEmail) calendarId = emp.googleEmail;
          }

          const calendar = google.calendar({ version: "v3", auth });
          const now = new Date();
          const deadline = new Date(task.dueDate);

          // Find busy slots
          const busyRes = await calendar.events.list({
            calendarId,
            timeMin: now.toISOString(),
            timeMax: deadline.toISOString(),
            singleEvents: true,
            orderBy: "startTime",
          });

          const busy = (busyRes.data.items ?? [])
            .filter((e: any) => e.start?.dateTime && e.end?.dateTime)
            .map((e: any) => ({ start: new Date(e.start.dateTime), end: new Date(e.end.dateTime) }));

          // Find first free slot during work hours (9-18)
          let slotFound = false;
          const cursor = new Date(Math.max(now.getTime(), new Date(now.toISOString().split("T")[0] + "T09:00:00").getTime()));

          for (let day = 0; day < 14; day++) {
            const dayStart = new Date(cursor);
            dayStart.setDate(dayStart.getDate() + day);
            dayStart.setHours(9, 0, 0, 0);
            const dayEnd = new Date(dayStart);
            dayEnd.setHours(18, 0, 0, 0);

            if (dayStart.getDay() === 0 || dayStart.getDay() === 6) continue;
            if (dayEnd > deadline) break;

            const effectiveStart = day === 0 && now > dayStart ? now : dayStart;
            let ptr = new Date(effectiveStart);
            const mins = ptr.getMinutes();
            if (mins % 15 !== 0) ptr.setMinutes(mins + (15 - (mins % 15)), 0, 0);

            const dayBusy = busy.filter((s: any) => s.start < dayEnd && s.end > ptr);
            dayBusy.sort((a: any, b: any) => a.start.getTime() - b.start.getTime());

            const trySlot = (from: Date) => {
              const gap = (dayEnd.getTime() - from.getTime()) / 60000;
              if (gap >= duration) {
                return { start: new Date(from), end: new Date(from.getTime() + duration * 60000) };
              }
              return null;
            };

            for (const b of dayBusy) {
              if (ptr < b.start) {
                const gap = (b.start.getTime() - ptr.getTime()) / 60000;
                if (gap >= duration) {
                  const slot = { start: new Date(ptr), end: new Date(ptr.getTime() + duration * 60000) };
                  const ev = await calendar.events.insert({
                    calendarId,
                    requestBody: {
                      summary: `[COO] ${task.title}`,
                      start: { dateTime: slot.start.toISOString() },
                      end: { dateTime: slot.end.toISOString() },
                      colorId: "9",
                      description: "Auto-scheduled by COO Assistant",
                    },
                  });
                  await db.update(tasks).set({
                    scheduledStart: slot.start, scheduledEnd: slot.end,
                    autoScheduled: true, calendarEventId: ev.data.id, updatedAt: new Date(),
                  }).where(eq(tasks.id, task.id));
                  const time = slot.start.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
                  const date = slot.start.toLocaleDateString("it-IT");
                  return `Task "${task.title}" schedulato nel calendario${calendarId !== "primary" ? ` di ${calendarId}` : ""}: ${date} alle ${time} (${duration} min).`;
                }
              }
              if (b.end > ptr) ptr = new Date(b.end);
            }

            // After last busy slot
            const remaining = trySlot(ptr);
            if (remaining) {
              const ev = await calendar.events.insert({
                calendarId,
                requestBody: {
                  summary: `[COO] ${task.title}`,
                  start: { dateTime: remaining.start.toISOString() },
                  end: { dateTime: remaining.end.toISOString() },
                  colorId: "9",
                  description: "Auto-scheduled by COO Assistant",
                },
              });
              await db.update(tasks).set({
                scheduledStart: remaining.start, scheduledEnd: remaining.end,
                autoScheduled: true, calendarEventId: ev.data.id, updatedAt: new Date(),
              }).where(eq(tasks.id, task.id));
              const time = remaining.start.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
              const date = remaining.start.toLocaleDateString("it-IT");
              return `Task "${task.title}" schedulato nel calendario${calendarId !== "primary" ? ` di ${calendarId}` : ""}: ${date} alle ${time} (${duration} min).`;
            }
          }

          return `Task "${task.title}" aggiornato (${duration} min) ma non c'e' uno slot libero prima della scadenza. Verra' riprovato al prossimo ciclo.`;
        } catch (err: any) {
          logger.error({ err }, "Immediate scheduling failed");
          return `Task "${task.title}" aggiornato (${duration} min). Scheduling automatico fallito: ${err.message}. Verra' riprovato.`;
        }
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

      if (name === "get_commitments") {
        return getCommitments(input.status ?? "open", input.employee_name, input.days ?? 7);
      }

      if (name === "get_team_sentiment") {
        return getTeamSentiment(input.employee_name, input.days ?? 7);
      }

      if (name === "get_communication_patterns") {
        return getCommunicationOverview(input.employee_name, input.days ?? 7);
      }

      if (name === "query_knowledge_base") {
        return queryKnowledge(input.query, input.category);
      }

      if (name === "get_topics") {
        const type = input.type ?? "all";
        if (type === "clients") return getClientMentions(input.days ?? 7);
        return getTopics(input.period ?? "today");
      }

      if (name === "get_meeting_intelligence") {
        return getMeetingStats();
      }

      if (name === "add_notion_comment") {
        const [task] = await db.select().from(tasks)
          .where(sql`${tasks.title} ILIKE ${"%" + input.task_title + "%"}`).limit(1);
        if (!task) return `Task "${input.task_title}" non trovato.`;
        if (!task.externalId?.startsWith("notion:")) return `Task "${task.title}" non ha un link Notion. Verra' sincronizzato al prossimo ciclo.`;
        const notionPageId = task.externalId.replace("notion:", "").replace("notion-done:", "");
        const ok = await addNotionComment(notionPageId, input.comment);
        return ok ? `Commento aggiunto al task "${task.title}" su Notion.` : `Errore nell'aggiungere il commento su Notion.`;
      }

      if (name === "create_notion_project") {
        const url = await createNotionProject(input.name, { status: input.status });
        return url ? `Progetto "${input.name}" creato su Notion: ${url}` : `Errore nella creazione del progetto. Verifica che NOTION_PROJECTS_DATABASE_ID sia configurato.`;
      }

      if (name === "get_project_eta") {
        return getProjectETA(input.project_name);
      }

      if (name === "create_project_from_description") {
        // AI generates task breakdown, then creates each task
        const breakdown = await this.think(
          `Genera un piano progetto basato su questa descrizione. Per ogni task specifica: titolo, priorita (low/medium/high/urgent), durata stimata in minuti, e dipendenze (se un task dipende da un altro).
Rispondi SOLO con JSON valido: [{"title": "...", "priority": "medium", "estimated_minutes": 120, "depends_on": null}]
Genera 5-10 task concreti e actionable.`,
          { description: input.description, deadline: input.deadline },
        );

        const start = breakdown.indexOf("[");
        const end = breakdown.lastIndexOf("]") + 1;
        if (start < 0 || end <= start) return "Non sono riuscito a generare il piano progetto. Riprova con una descrizione più dettagliata.";

        const planTasks: Array<{ title: string; priority: string; estimated_minutes: number; depends_on: string | null }> = JSON.parse(breakdown.slice(start, end));

        const created: string[] = [];
        const taskMap = new Map<string, string>(); // title -> id

        for (const pt of planTasks) {
          const [result] = await db.insert(tasks).values({
            title: pt.title,
            priority: pt.priority ?? "medium",
            estimatedMinutes: pt.estimated_minutes ?? 60,
            dueDate: input.deadline ? parseLocalDate(input.deadline) : null,
            source: "ai",
            status: "pending",
          }).returning({ id: tasks.id });

          taskMap.set(pt.title, result.id);
          created.push(`- ${pt.title} (${pt.priority}, ~${pt.estimated_minutes}min)`);
        }

        // Set dependencies
        for (const pt of planTasks) {
          if (pt.depends_on && taskMap.has(pt.depends_on) && taskMap.has(pt.title)) {
            const depId = taskMap.get(pt.depends_on)!;
            await db.update(tasks)
              .set({ blockedBy: JSON.stringify([depId]) })
              .where(eq(tasks.id, taskMap.get(pt.title)!));
          }
        }

        return `Progetto creato con ${created.length} task:\n${created.join("\n")}${input.deadline ? `\nDeadline: ${input.deadline}` : ""}`;
      }

      if (name === "delete_calendar_event") {
        if (input.event_id) {
          const deleted = await deleteCalendarEvent(input.event_id, userAuth);
          return deleted
            ? `Evento calendario eliminato.`
            : `Impossibile eliminare l'evento (potrebbe essere gia' stato rimosso).`;
        }
        if (input.event_summary) {
          const events = await getTodayEvents(userAuth);
          const match = events.find((e) => e.summary.toLowerCase().includes(input.event_summary.toLowerCase()));
          if (!match) return `Nessun evento trovato con nome "${input.event_summary}" nel calendario di oggi.`;
          const deleted = await deleteCalendarEvent(match.id, userAuth);
          return deleted
            ? `Evento "${match.summary}" eliminato dal calendario.`
            : `Impossibile eliminare "${match.summary}".`;
        }
        return "Specifica event_id o event_summary per eliminare un evento.";
      }

      if (name === "unschedule_task") {
        const [task] = await db.select().from(tasks)
          .where(sql`${tasks.title} ILIKE ${"%" + input.task_title + "%"}`).limit(1);
        if (!task) return `Task "${input.task_title}" non trovato.`;
        if (!task.autoScheduled && !task.calendarEventId) return `Task "${task.title}" non e' schedulato nel calendario.`;
        await unscheduleTask(task.id);
        return `Task "${task.title}" rimosso dal calendario.`;
      }

      return `Tool "${name}" non riconosciuto.`;
    } catch (err: any) {
      logger.error({ err, tool: name }, "Tool execution failed");
      return `Errore nell'esecuzione: ${err.message}`;
    }
  }

  private async buildContextForRole(
    query: string,
    role: AccessRole,
    employeeId: string | null,
    userAuth?: GoogleAuth | null,
  ): Promise<Record<string, unknown>> {
    const context: Record<string, unknown> = {
      today: new Date().toISOString().split("T")[0],
    };

    if (role === "viewer") {
      // Viewer: only own tasks + calendar + basic counts
      const myTasks = employeeId
        ? await db.select().from(tasks).where(and(eq(tasks.assignedTo, employeeId), inArray(tasks.status, ["pending", "in_progress"])))
        : [];

      const [taskCountRow] = await db.select({ count: sql<number>`count(*)` }).from(tasks)
        .where(inArray(tasks.status, ["pending", "in_progress"]));

      const calendarEvents = await getTodayEvents(userAuth).catch(() => []);

      context.my_tasks = myTasks.map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, due: t.dueDate }));
      context.total_active_tasks = taskCountRow?.count ?? 0;
      context.calendar_events_today = calendarEvents.map((e) => ({ summary: e.summary, start: e.start, end: e.end }));
      return context;
    }

    // Admin + Owner: full operational data
    const [allEmployees, allClients, activeTasks] = await Promise.all([
      db.select().from(employees).where(eq(employees.isActive, true)),
      db.select().from(clients).where(eq(clients.isActive, true)),
      db.select().from(tasks).where(inArray(tasks.status, ["pending", "in_progress"])),
    ]);

    const [calendarEvents, importantEmails, notionData, driveFiles] = await Promise.all([
      getTodayEvents(userAuth).catch(() => []),
      getUnreadImportantEmails(5, userAuth).catch(() => []),
      isNotionConfigured() ? getNotionWorkspaceSummary().catch(() => null) : Promise.resolve(null),
      listDriveFiles(10, userAuth).catch(() => []),
    ]);

    const recentSlackMessages = await db.select().from(messageLogs)
      .where(and(eq(messageLogs.source, "slack"), sql`${messageLogs.receivedAt} > now() - interval '24 hours'`));

    context.employees = allEmployees.map((e) => ({ id: e.id, name: e.name, role: e.role }));
    context.clients = allClients.map((c) => ({ id: c.id, name: c.name, company: c.company }));
    context.active_tasks = activeTasks.map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, due: t.dueDate }));
    context.calendar_events_today = calendarEvents.map((e) => ({ summary: e.summary, start: e.start, end: e.end, location: e.location }));
    context.unread_important_emails = importantEmails.map((e) => ({ from: e.from, subject: e.subject, snippet: e.snippet }));
    context.recent_slack_messages = recentSlackMessages.map((m) => ({ channel: m.chatTitle, sender: m.senderName, urgency: m.urgency, summary: m.content.slice(0, 200), received: m.receivedAt }));
    context.notion_tasks = notionData?.tasks.map((t) => ({ title: t.title, status: t.status, priority: t.priority, assignee: t.assignee, due: t.dueDate, overdue: t.isOverdue })) ?? [];
    context.notion_projects = notionData?.projects.map((p) => ({ name: p.name, status: p.status, owner: p.owner })) ?? [];
    context.drive_files = driveFiles.map((f) => ({ name: f.name, link: f.webViewLink, created: f.createdTime }));
    context.slack_notifications_configured = !!config.SLACK_NOTIFICATIONS_CHANNEL;

    // Historical data for date/employee queries
    const dateRange = parseDateKeywords(query);
    const employeeMatch = await findEmployeeInQuery(query);

    if (dateRange) {
      const historicalData = await getActivityByDateRange(dateRange).catch(() => null);
      if (historicalData) context.historical_data = historicalData;
    }
    if (employeeMatch && dateRange) {
      const activity = await getEmployeeActivity(employeeMatch.id, dateRange).catch(() => null);
      if (activity) context.employee_activity = activity;
    } else if (employeeMatch) {
      const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);
      const activity = await getEmployeeActivity(employeeMatch.id, { start: weekAgo, end: new Date() }).catch(() => null);
      if (activity) context.employee_activity = activity;
    }

    return context;
  }

  async answerQuery(
    query: string,
    userRole: AccessRole = "owner",
    employeeId: string | null = null,
  ): Promise<AgentResponse> {
    this.collectedFiles = [];

    // Resolve per-user Google auth (falls back to global if no personal token)
    const userAuth = await getAuthForEmployee(employeeId);

    // Build context based on role
    const context = await this.buildContextForRole(query, userRole, employeeId, userAuth);

    // Filter tools based on role
    const allowedNames = getAllowedToolNames(userRole);
    const filteredTools = this.tools.filter((t) => allowedNames.has(t.name));

    // Build role-aware system prompt
    const rolePromptSuffix = userRole === "owner" ? "" :
      userRole === "admin"
        ? "\n\nL'utente ha ruolo ADMIN. Puo' creare/modificare task, inviare messaggi, generare report. NON puo' accedere a: sentiment team, communication patterns, commitments, knowledge base, gestione team. Se chiede queste cose, rispondi che non ha i permessi."
        : "\n\nL'utente ha ruolo VIEWER. Puo' SOLO consultare i propri task e il calendario. NON puo' creare/modificare task, inviare messaggi, vedere email, slack, report, o dati di altri employee. Se chiede queste cose, rispondi che non ha i permessi.";

    // --- Tool use loop ---
    const contextStr = `Context:\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\`\n\n${query}`;

    let messages: any[] = [{ role: "user", content: contextStr }];
    let textParts: string[] = [];

    for (let i = 0; i < 5; i++) { // max 5 tool call rounds
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: COO_SYSTEM_PROMPT + rolePromptSuffix,
        tools: filteredTools,
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
          const result = await this.executeTool(block.name, block.input as Record<string, any>, userAuth);
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
