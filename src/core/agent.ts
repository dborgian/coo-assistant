import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, gte, ilike, inArray, lt, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../models/database.js";
import { clients, dailyReports, employees, intelligenceEvents, messageLogs, tasks } from "../models/schema.js";
import { logger } from "../utils/logger.js";
import { getTodayEvents, getTeamEvents } from "../services/calendar-sync.js";
import { sendTieredNotification, getTargetLevel } from "../services/task-reminder.js";
import { getUnreadImportantEmails, sendEmail, searchEmails, forwardEmail, replyToEmail } from "../services/email-manager.js";
import { getNotionWorkspaceSummary, isNotionConfigured, createNotionTask, searchNotion, updateNotionTaskStatus, discoverNotionUsers, extractNotionPageId } from "../services/notion-sync.js";
import { parseDateKeywords, findEmployeeInQuery, getActivityByDateRange, getEmployeeActivity } from "../services/history-query.js";
import { takeScreenshot } from "../services/screenshot.js";
import { listDriveFiles, searchDriveFiles, uploadFileToDrive } from "../services/drive-manager.js";
import { getAuthForEmployee, getGoogleAuth, getUserGoogleAuth } from "./google-auth.js";
import type { GoogleAuth } from "./google-auth.js";
import { generateDailyReportPdf, generateEmployeeReportPdf, generateWeeklyReportPdf, type DailyReportData } from "../services/pdf-generator.js";
import { sendSlackMessage, getNotificationsChannel } from "../bot/slack-monitor.js";
import { sendEmployeeNotification, sendOwnerNotification } from "../utils/notify.js";
import { getTeamWorkload, type WorkloadSummary } from "../services/workload-tracker.js";
import { getTeamCapacity, suggestAssignment } from "../services/capacity-planner.js";
import { rescheduleTask, unscheduleTask } from "../services/auto-scheduler.js";
import { deleteCalendarEvent } from "../services/calendar-sync.js";
import { createGoogleTask, completeGoogleTask, updateGoogleTask, deleteGoogleTask } from "../services/google-tasks-sync.js";
import { getProjectETA } from "../services/project-eta.js";
import { addNotionComment, createNotionProject, createNotionMeetingAction, updateNotionTaskProperties, archiveNotionPage } from "../services/notion-sync.js";
import { getCommitments } from "../services/commitment-tracker.js";
import { computeHealthScore, formatHealthScore } from "../services/health-score.js";
import { muteNotif, unmuteNotif, getMutedTypes, ALL_NOTIF_TYPES } from "../utils/notification-prefs.js";
import { getRecentBotActions } from "../services/bot-actions.js";
import { getTeamSentiment } from "../services/sentiment-analyzer.js";
import { getCommunicationOverview } from "../services/communication-patterns.js";
import { queryKnowledge } from "../services/knowledge-base.js";
import { getTopics, getClientMentions } from "../services/topic-analyzer.js";
import { getMeetingStats } from "../services/meeting-intelligence.js";
import { createGoogleDoc } from "../services/google-docs-manager.js";
import { processMeetingDocById } from "../services/meeting-notes.js";
import { loadBrainContext, getBrainStatus, resolveDecision, queryBrain, addFactToBrain } from "../services/company-brain.js";
import { unifiedSearch } from "../services/unified-search.js";
import type { Tool, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages.js";
import type { AccessRole } from "../bot/auth-types.js";
import { getAllowedToolNames } from "../bot/permissions.js";
import { getConversationHistory, addToConversation } from "../utils/conversation-cache.js";
import { getUserMemories, formatMemoriesForPrompt, extractAndSaveMemories } from "../services/user-memory.js";
import { compressConversationIfNeeded } from "../services/context-compressor.js";
import { logBotAction } from "../services/bot-actions.js";

export interface AgentResponse {
  text: string;
  files?: Array<{ buffer: Buffer; filename: string }>;
}

const COO_SYSTEM_PROMPT = `\
Sei il COO AI di una startup. Rispondi in modo CONCISO e DIRETTO.

REGOLE DI STILE:
- Rispondi nella lingua dell'utente (italiano o inglese)
- Sii breve: rispondi alla domanda, poi fermati. Niente commenti extra.
- NON aggiungere metriche, grafici o sezioni extra a meno che l'utente non le chieda esplicitamente
- NON ripetere informazioni gia note all'utente
- NON fare speculazioni o osservazioni non richieste
- Quando esegui un'azione, conferma in UNA frase cosa hai fatto
- Usa elenchi puntati solo se ci sono 3+ elementi
- IMPORTANTE: il campo [Messaggio da: Nome] indica CHI sta parlando. Non confondere mittente e destinatario.

RESPONSABILITA:
- Monitorare tutti i canali (Slack, Gmail, Calendar, Notion)
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
- Interagire con Notion: creare task, aggiornare task esistenti (status/deadline/assignee/priorità), cercare pagine (notion_action)
- Per le scadenze: calcola la data/ora assoluta usando current_datetime e timezone dal context. Formato: YYYY-MM-DDTHH:mm. Se l'utente specifica una timezone diversa (es. "ora italiana", "ora di New York", "alle 14 fuso orario Roma"), aggiungi il parametro timezone nel tool call con il valore IANA (es. "Europe/Rome", "America/New_York") — il sistema interpreterà due_date in quella timezone
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
- Vedere l'health score operativo con breakdown dettagliato (get_health_score)
- Generare un recap AI delle ultime N ore di attivita' (get_recap)
- Gestire le preferenze notifiche personali — silenziare/riattivare tipi (manage_notifications)
- Vedere il log delle azioni autonome del bot (get_audit_log)
- Vedere una panoramica completa del team con workload, task attivi e scaduti (get_team_overview)
- Analizzare il morale e sentiment del team (get_team_sentiment)
- Vedere pattern di comunicazione, tempi di risposta, employee silenziosi (get_communication_patterns)
- Consultare la knowledge base aziendale (query_knowledge_base)
- Vedere trending topics e clienti piu' discussi (get_topics)
- Statistiche meeting e overload (get_meeting_intelligence)
- Aggiungere commenti/note ai task su Notion (add_notion_comment)
- Creare progetti su Notion (create_notion_project)

CONTESTO CONVERSAZIONE:
- Trovi nella conversazione i messaggi precedenti dell'utente e le tue risposte passate. Usali per disambiguare riferimenti come "quello", "assegnalo", "completalo", "quell'email", "quel task".
- Se l'utente dice "assegnalo a X" senza specificare cosa, cerca nell'ultimo messaggio precedente il task o elemento a cui si riferisce.

MEMORIA UTENTE:
- Se nel system prompt trovi la sezione PREFERENZE UTENTE, usala per personalizzare le risposte.
- Le preferenze "confermate piu volte" devono essere suggerite proattivamente: es. "Lo preferisci in Word come le altre volte?".
- Le preferenze non ancora consolidate applicale in silenzio, senza chiedere conferma.

GESTIONE AMBIGUITA':
- Se un messaggio e' vago o incompleto (es. "crea task", "aggiorna", senza dettagli), chiedi subito la informazione mancante con una domanda breve e diretta. NON indovinare.
- Se un tool restituisce "Trovati N task corrispondenti", NON proseguire: chiedi all'utente quale intende.
- Se un tool restituisce un errore di employee non trovato, mostra la lista dei dipendenti disponibili e chiedi di specificare.
- Se la data e' ambigua (es. "venerdì", "la prossima settimana"), usa current_datetime dal context per calcolarla esattamente.
- REGOLA FERREA create_task / notion_action create_task: se mancano priority O due_date O assignee, NON impostare confirmed=true. Il tool restituira' una lista dei campi mancanti — mostrala all'utente e chiedi conferma. Solo dopo risposta esplicita dell'utente chiama il tool con confirmed=true (e con i valori specificati, se li ha forniti).
- REGOLA FERREA send_email / forward_email / reply_email: NON chiamare il tool se mancano destinatario, oggetto, O corpo dell'email. Prima chiedi all'utente le informazioni mancanti. Solo dopo aver raccolto TUTTI i parametri necessari, chiama il tool.

ESEMPI:
- Utente: "crea task report" → se manca l'assignee o la scadenza, chiedi: "A chi assegno il task e entro quando?"
- Utente: "aggiorna il task design" → se ci sono piu' task con "design" nel titolo, mostra la lista e chiedi quale.
- Utente: "completa il task" → chiedi: "Quale task vuoi completare?"

SYNC NOTION BIDIREZIONALE:
- Task creati qui appaiono su Notion entro 1 minuto
- Task completati/cancellati qui aggiornano lo status su Notion
- Task creati su Notion vengono importati qui automaticamente
- Cambi di priorita/deadline si sincronizzano in entrambe le direzioni

SEZIONI NOTION DISPONIBILI (usa il parametro section nel tool notion_action):
- "tasks" (default): database task principale
- "action_items": database meeting action items — usa quando l'utente dice "action items", "azioni meeting", "nella sezione action items"
- "projects": database progetti — usa quando l'utente dice "progetto", "project", "nella sezione progetti"
Se l'utente specifica una sezione Notion, DEVI passare il parametro section corretto.
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
function parseLocalDate(dateStr: string, tzOverride?: string): Date {
  const tz = tzOverride || config.TIMEZONE || "Europe/Rome";

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

  constructor() {
    this.client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    this.model = config.AGENT_MODEL;
  }

  async think(
    prompt: string,
    context?: Record<string, unknown>,
    skipBrain = false,
  ): Promise<string> {
    const content = context
      ? `Context:\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\`\n\n${prompt}`
      : prompt;

    const brainCtx = skipBrain ? "" : await loadBrainContext().catch(() => "");
    const systemPrompt = brainCtx ? COO_SYSTEM_PROMPT + brainCtx : COO_SYSTEM_PROMPT;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: systemPrompt,
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
      try {
        const start = result.indexOf("{");
        const end = result.lastIndexOf("}") + 1;
        if (start >= 0 && end > start) {
          return JSON.parse(result.slice(start, end));
        }
      } catch {
        // fall through to default
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
          timezone: { type: "string", description: "IANA timezone for due_date if the user specifies a timezone different from their default (e.g. 'Europe/Rome', 'America/New_York'). Omit if the user's default timezone applies." },
          confirmed: { type: "boolean", description: "Set to true ONLY after the user has explicitly confirmed they want to create the task with the current info. If priority, due_date, or assigned_to_name are missing, first show a summary of missing fields and ask the user to confirm or provide them." },
        },
        required: ["title"],
      },
    },
    {
      name: "send_slack_notification",
      description: "Send a message on Slack. Can send to a channel or DM a specific person. To DM someone, use their name in recipient_name.",
      input_schema: {
        type: "object" as const,
        properties: {
          message: { type: "string", description: "The message to send" },
          channel_id: { type: "string", description: "Slack channel ID (optional)" },
          recipient_name: { type: "string", description: "Employee name to DM directly (optional, uses their slackMemberId)" },
        },
        required: ["message"],
      },
    },
    {
      name: "send_email",
      description: "Send an email to an employee or any address. Prefer to_name (employee name) over to (email address) — the system resolves the correct address from the DB, avoiding hallucination errors.",
      input_schema: {
        type: "object" as const,
        properties: {
          to_name: { type: "string", description: "Recipient employee name — resolves email from DB (preferred, avoids hallucination)" },
          to: { type: "string", description: "Recipient email address (use only when to_name is unavailable or recipient is external)" },
          subject: { type: "string", description: "Email subject line" },
          body: { type: "string", description: "Email body text" },
          cc: { type: "string", description: "CC email address (optional)" },
        },
        required: ["subject", "body"],
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
      description: "Interact with Notion workspace. Create tasks, update existing tasks (status, deadline, assignee, priority), delete/archive tasks, or search for pages/databases.",
      input_schema: {
        type: "object" as const,
        properties: {
          action: { type: "string", enum: ["create_task", "update_task", "search", "delete_task"], description: "Action to perform" },
          query: { type: "string", description: "Search query (for search action)" },
          title: { type: "string", description: "Task title (for create_task) or task name to find (for update_task)" },
          description: { type: "string", description: "Task description / body text (for create_task)" },
          status: { type: "string", description: "Task status (e.g. 'In progress', 'Done', 'Not started')" },
          priority: { type: "string", description: "Task priority (e.g. 'High', 'Medium', 'Low')" },
          due_date: { type: "string", description: "Due date in YYYY-MM-DD or YYYY-MM-DDTHH:mm format (e.g. 2026-03-30T18:00). Always include time if the user specifies or implies one (e.g. 'tra 3 ore', 'alle 14')." },
          assignee: { type: "string", description: "Employee name to assign the task to" },
          timezone: { type: "string", description: "IANA timezone for due_date if the user specifies a timezone different from their default (e.g. 'Europe/Rome', 'America/New_York'). Omit if the user's default timezone applies." },
          section: { type: "string", enum: ["tasks", "action_items", "projects"], description: "Notion database/section to target for create_task. 'tasks' (default) = main tasks DB, 'action_items' = meeting action items DB (use when user says 'action items', 'azioni meeting', 'nella sezione action items'), 'projects' = projects DB (use when user says 'progetto', 'project')." },
          confirmed: { type: "boolean", description: "Set to true ONLY after the user has explicitly confirmed they want to create the task with the current info. If priority, due_date, or assignee are missing, first show a summary and ask the user to confirm or provide them." },
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
          timezone: { type: "string", description: "IANA timezone for new_due_date if the user specifies a timezone different from their default (e.g. 'Europe/Rome', 'America/New_York'). Omit if the user's default timezone applies." },
        },
        required: ["task_title", "action"],
      },
    },
    {
      name: "get_calendar_events",
      description: "Get calendar events for today. Can fetch for a specific employee by name, or for the entire team.",
      input_schema: {
        type: "object" as const,
        properties: {
          date: { type: "string", description: "Date YYYY-MM-DD (default: today)" },
          employee_name: { type: "string", description: "Employee name to get their calendar, or 'team'/'all'/'tutti' for all employees' calendars" },
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
      name: "get_team_overview",
      description: "Get a comprehensive team overview with workload percentage, active task counts, and overdue tasks per employee. Use when user asks: 'com\\'e\\' il team?', 'overview del team', 'stato dei dipendenti', 'chi ha piu\\' lavoro?', 'team overview', '/coo-team'.",
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
    {
      name: "create_google_doc",
      description: "Create a Google Doc with specified content. Use for meeting notes, reports, summaries, or any document the user wants saved to Drive.",
      input_schema: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: "Document title" },
          content: { type: "string", description: "Document content (plain text)" },
        },
        required: ["title", "content"],
      },
    },
    {
      name: "unified_search",
      description: "Search across all tools simultaneously: Google Drive, Notion, Gmail, Slack messages, tasks, and knowledge base. Use when user asks to find something across multiple sources.",
      input_schema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Search query" },
          source: { type: "string", enum: ["all", "drive", "notion", "tasks", "slack", "knowledge"], description: "Filter by source (default: all)" },
        },
        required: ["query"],
      },
    },
    {
      name: "forward_email",
      description: "Forward an email (with attachments) to someone. First use search_emails to find the email, then forward it by ID.",
      input_schema: {
        type: "object" as const,
        properties: {
          email_query: { type: "string", description: "Search query to find the email (subject, sender, keywords)" },
          to: { type: "string", description: "Recipient email address" },
          to_name: { type: "string", description: "Recipient name (resolves email from employees table)" },
          note: { type: "string", description: "Optional note to add at the top of the forwarded email" },
        },
        required: [],
      },
    },
    {
      name: "reply_email",
      description: "Reply or reply-all to an email. First use search_emails to find the email, then reply by ID.",
      input_schema: {
        type: "object" as const,
        properties: {
          email_query: { type: "string", description: "Search query to find the email to reply to" },
          body: { type: "string", description: "Reply text" },
          reply_all: { type: "boolean", description: "Reply to all recipients (default: false)" },
        },
        required: ["body"],
      },
    },
    {
      name: "search_emails",
      description: "Search Gmail for emails matching a query. Returns email IDs, subjects, senders, and snippets. Use Gmail search syntax (from:, subject:, has:attachment, etc).",
      input_schema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Gmail search query" },
          max_results: { type: "number", description: "Max results (default: 5)" },
        },
        required: ["query"],
      },
    },
    {
      name: "process_meeting_notes",
      description: "Process meeting notes from a Google Doc: generates AI summary, extracts action items with priority, creates Notion tasks, optionally sends email. If no doc_url is provided, automatically finds the latest unprocessed meeting notes email in Gmail. Use for: 'riassumi il meet', 'processa le note', 'fai il riassunto dell\\'ultimo meeting', 'invia il riassunto a...'.",
      input_schema: {
        type: "object" as const,
        properties: {
          doc_url: { type: "string", description: "Google Doc URL or ID (optional — omit to auto-find latest meeting notes from Gmail)" },
          send_to: { type: "string", description: "Email address or person name to send the summary to (optional)" },
        },
        required: [],
      },
    },
    {
      name: "brain_status",
      description: "Show the current state of the Company Brain: how many meetings, open decisions, and company facts are stored. Use for: 'stato del cervello', 'cosa ricordi', 'quante riunioni hai in memoria', 'mostra il brain'.",
      input_schema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    {
      name: "query_brain",
      description: "Search the Company Brain for specific information about meetings, decisions, or company facts. Use for: 'cosa sai di X?', 'chi è responsabile di Y?', 'quando abbiamo deciso Z?', 'trova informazioni su progetto X'.",
      input_schema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Keywords to search for in the brain" },
          category: { type: "string", enum: ["meeting", "decision", "team", "project", "client", "process"], description: "Limit search to a specific category (optional). Use meeting/decision for those types, or team/project/client/process for company facts." },
        },
        required: ["query"],
      },
    },
    {
      name: "add_brain_fact",
      description: "Manually add a stable company fact to the brain memory. Use for: 'ricorda che...', 'aggiungi al cervello...', 'salva questa informazione: ...'.",
      input_schema: {
        type: "object" as const,
        properties: {
          fact: { type: "string", description: "The fact to remember (clear, self-contained sentence)" },
          category: { type: "string", enum: ["team", "project", "client", "process", "decision"], description: "Category of the fact" },
        },
        required: ["fact"],
      },
    },
    {
      name: "resolve_decision",
      description: "Mark an open decision as resolved and remove it from the brain. Use for: 'la decisione X è stata presa', 'chiudi la decisione su Y', 'segna come risolta la questione Z'.",
      input_schema: {
        type: "object" as const,
        properties: {
          decision_text: { type: "string", description: "Keyword or partial text of the decision to resolve" },
        },
        required: ["decision_text"],
      },
    },
    {
      name: "get_health_score",
      description: "Get the operational health score (0-100) with breakdown: task completion rate, overdue ratio, team workload balance, open commitments. Use when user asks: 'come sta il team?', 'health score', 'stato operativo', 'salute aziendale', 'mostra l\\'health score', '/coo-health'.",
      input_schema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    {
      name: "get_recap",
      description: "Generate an AI-powered operational recap for the last N hours: completed tasks, new tasks, Slack activity, bot actions. Use when user asks: 'recap', 'riassunto', 'cosa è successo', 'fammi il punto', 'situazione delle ultime X ore', 'digest delle ultime 24h'.",
      input_schema: {
        type: "object" as const,
        properties: {
          hours: { type: "number", description: "Hours to look back (default 24, max 72)" },
        },
        required: [],
      },
    },
    {
      name: "get_audit_log",
      description: "Get the audit log of recent autonomous actions taken by the bot: emails sent, tasks created, escalations triggered, etc. Use when user asks: 'cosa hai fatto?', 'audit', 'azioni autonome', 'log del bot', 'mostra le azioni recenti', '/coo-audit'.",
      input_schema: {
        type: "object" as const,
        properties: {
          limit: { type: "number", description: "Number of recent actions to show (default 20, max 50)" },
        },
        required: [],
      },
    },
    {
      name: "manage_notifications",
      description: "List, mute, or unmute personal notification types. Types: escalations, email_alerts, proactive, task_reminders, meeting_notes. Use when user says: 'silenzia le notifiche escalation', 'disattiva le email alert', 'riattiva i reminder', 'mostra preferenze notifiche', 'quali notifiche ho silenziato?'.",
      input_schema: {
        type: "object" as const,
        properties: {
          action: { type: "string", enum: ["list", "mute", "unmute"], description: "Action (default: list)" },
          type: { type: "string", enum: ["escalations", "email_alerts", "proactive", "task_reminders", "meeting_notes"], description: "Notification type to mute/unmute" },
        },
        required: [],
      },
    },
    {
      name: "take_screenshot",
      description: "Take a screenshot of a publicly accessible URL and attach it to the response. IMPORTANT: does NOT work for Google Docs, Google Drive, Notion, Slack, or any page that requires login — those will redirect to a login screen. For Google Docs/Drive content use search_drive or get_calendar_events; for Notion use notion_action.",
      input_schema: {
        type: "object" as const,
        properties: {
          url: { type: "string", description: "Full URL to screenshot (must be publicly accessible)" },
          full_page: { type: "boolean", description: "Capture full page scroll height (default: false = viewport only)" },
        },
        required: ["url"],
      },
    },
  ];

  // --- Execute a tool call ---
  private async executeTool(name: string, input: Record<string, any>, userAuth?: GoogleAuth | null, userTz?: string, collectedFiles?: Array<{ buffer: Buffer; filename: string }>, slackUserId?: string): Promise<string> {
    try {
      if (name === "create_task") {
        // Auto-assign: if no assignee specified, pick the least-loaded available employee
        let autoAssignedId: string | null = null;
        let autoAssignedName: string | null = null;
        let autoAssignPct: number | null = null;
        if (!input.assigned_to_name) {
          try {
            const workload = await getTeamWorkload();
            const available = workload
              .filter((w) => w.workloadScore < 0.8)
              .sort((a, b) => a.workloadScore - b.workloadScore);
            if (available.length) {
              const best = available[0];
              const [emp] = await db
                .select({ id: employees.id })
                .from(employees)
                .where(sql`${employees.name} ILIKE ${"%" + best.employeeName + "%"}`)
                .limit(1);
              if (emp) {
                autoAssignedId = emp.id;
                autoAssignedName = best.employeeName;
                autoAssignPct = Math.round(best.workloadScore * 100);
              }
            }
          } catch { /* non-critical — skip silently */ }
        }

        // Check for missing key fields — ask user to confirm only if 2+ fields truly missing
        const missingFields: string[] = [];
        if (!input.priority) missingFields.push("priorita' (default: media)");
        if (!input.due_date) missingFields.push("scadenza (default: nessuna)");
        // Assignee only counts as missing if auto-assign also failed
        if (!input.assigned_to_name && !autoAssignedName) missingFields.push("assegnatario (default: nessuno)");
        if (missingFields.length >= 2 && !input.confirmed) {
          const autoNote = autoAssignedName
            ? `\n💡 Assegnatario auto-selezionato: ${autoAssignedName} (workload ${autoAssignPct}%)`
            : "";
          return `Prima di creare il task "${input.title}", mancano alcune informazioni:${autoNote}\n` +
            missingFields.map((f) => `- ${f}`).join("\n") +
            `\n\nVuoi procedere con i default o preferisci specificarli?`;
        }

        // Resolve assignee: explicit name overrides auto-assign
        let assignedTo: string | null = autoAssignedId;
        if (input.assigned_to_name) {
          const [emp] = await db.select({ id: employees.id }).from(employees)
            .where(sql`${employees.name} ILIKE ${"%" + input.assigned_to_name + "%"}`).limit(1);
          if (!emp) {
            const allEmps = await db.select({ name: employees.name }).from(employees);
            const names = allEmps.map((e) => e.name).join(", ");
            return `Employee "${input.assigned_to_name}" non trovato. Dipendenti disponibili: ${names || "nessuno registrato"}.`;
          }
          assignedTo = emp.id;
          autoAssignedName = null; // explicit — clear auto flag
        }

        const [newTask] = await db.insert(tasks).values({
          title: input.title,
          description: input.description ?? null,
          priority: input.priority ?? "medium",
          assignedTo,
          dueDate: input.due_date ? parseLocalDate(input.due_date, input.timezone ?? userTz) : null,
          source: "ai",
          status: "pending",
        }).returning({ id: tasks.id });

        // Sync to Google Tasks
        if (newTask) {
          createGoogleTask(newTask.id).catch((e) => logger.error({ err: e, taskId: newTask.id }, "Google Tasks sync on create failed"));
        }

        // Sync to Notion — awaited to prevent race with syncTasksToNotion cron
        if (isNotionConfigured()) {
          try {
            const notionUrl = await createNotionTask(input.title, {
              assignee: input.assigned_to_name,
              dueDate: input.due_date,
              priority: input.priority,
              description: input.description,
            });
            if (notionUrl && newTask?.id) {
              const pageId = extractNotionPageId(notionUrl);
              if (pageId) {
                await db.update(tasks).set({ externalId: `notion:${pageId}` }).where(eq(tasks.id, newTask.id));
              }
            }
          } catch (e) {
            logger.error({ err: e, taskId: newTask?.id }, "Notion sync from create_task failed");
          }
        }

        // Instant tiered notification to assignee based on time to deadline
        if (assignedTo && input.due_date) {
          const [assigneeEmp] = await db
            .select({ name: employees.name, email: employees.email, googleEmail: employees.googleEmail, slackMemberId: employees.slackMemberId, timezone: employees.timezone })
            .from(employees).where(eq(employees.id, assignedTo)).limit(1);
          if (assigneeEmp) {
            const parsedDue = input.due_date ? parseLocalDate(input.due_date, input.timezone ?? userTz) : null;
            if (parsedDue) {
              const hoursLeft = (parsedDue.getTime() - Date.now()) / 3_600_000;
              const level = getTargetLevel(hoursLeft);
              sendTieredNotification(
                { id: newTask?.id, title: input.title, priority: input.priority ?? "medium", description: input.description ?? null, dueDate: parsedDue },
                assigneeEmp,
                "Nuova task assegnata",
              ).catch((e) => logger.error({ err: e }, "Assignment notification failed"));
              // Mark reminderLevel so the cron doesn't re-send this checkpoint
              if (newTask?.id && level > 0) {
                db.update(tasks).set({ reminderLevel: level }).where(eq(tasks.id, newTask.id))
                  .catch((e) => logger.error({ err: e, taskId: newTask.id }, "reminderLevel update failed"));
              }
            }
          }
        }

        // Direct DM to assignee when no due_date (tiered notification handles the due_date case)
        if (assignedTo && !input.due_date) {
          const prioLabel = input.priority ?? "medium";
          sendEmployeeNotification(assignedTo, `📋 Nuovo task assegnato a te: *${input.title}* (priorità: ${prioLabel})`).catch(() => {});
        }

        // Also notify on Slack
        const notifChannel = getNotificationsChannel();
        const effectiveAssigneeName = input.assigned_to_name ?? autoAssignedName;
        if (notifChannel) {
          const assigneeLabel = effectiveAssigneeName
            ? ` (assegnato a ${effectiveAssigneeName}${autoAssignedName ? " — auto" : ""})`
            : "";
          await sendSlackMessage(
            notifChannel,
            `📋 Nuovo task: *${input.title}*${assigneeLabel} — Priority: ${input.priority ?? "medium"}`,
          ).catch(() => {});
        }

        // Log autonomous assignment
        if (autoAssignedName && newTask?.id) {
          logBotAction("task_auto_assigned", `Task "${input.title}" auto-assegnato a ${autoAssignedName} (workload ${autoAssignPct}%)`, { taskId: newTask.id, assignee: autoAssignedName }).catch(() => {});
        }

        const assignNote = effectiveAssigneeName
          ? ` e assegnato a ${effectiveAssigneeName}${autoAssignedName ? ` (auto-selezionato — workload ${autoAssignPct}%)` : ""}`
          : "";
        return `Task "${input.title}" creato con successo${assignNote}. ${notifChannel ? "Notifica inviata su Slack." : ""}${isNotionConfigured() ? " Sincronizzato su Notion." : ""}`;
      }

      if (name === "send_slack_notification") {
        let channelId = input.channel_id || getNotificationsChannel();

        // DM a specific person by name
        if (input.recipient_name) {
          const [emp] = await db.select({ slackMemberId: employees.slackMemberId, name: employees.name })
            .from(employees)
            .where(sql`${employees.name} ILIKE ${"%" + input.recipient_name + "%"}`)
            .limit(1);
          if (emp?.slackMemberId) {
            channelId = emp.slackMemberId;
          } else {
            return `Employee "${input.recipient_name}" non trovato o non ha Slack collegato.`;
          }
        }

        if (!channelId) return "Slack notifications channel non configurato. Imposta SLACK_NOTIFICATIONS_CHANNEL nel .env.";
        const sent = await sendSlackMessage(channelId, input.message);
        return sent ? `Messaggio inviato su Slack${input.recipient_name ? ` a ${input.recipient_name}` : ""}.` : "Invio fallito — controlla la configurazione Slack.";
      }

      if (name === "send_email") {
        let toAddress: string = input.to ?? "";
        // Resolve from employees DB when to_name is given, or when to doesn't look like an email
        if (input.to_name || !toAddress.includes("@")) {
          const searchName = input.to_name || toAddress;
          if (searchName) {
            const empMatches = await db
              .select({ name: employees.name, email: employees.email, googleEmail: employees.googleEmail })
              .from(employees)
              .where(sql`${employees.name} ILIKE ${"%" + searchName + "%"}`);
            if (empMatches.length > 1) {
              return `Trovati ${empMatches.length} dipendenti per "${searchName}":\n${empMatches.map((e) => `- ${e.name}: ${e.googleEmail ?? e.email ?? "nessuna email"}`).join("\n")}\nSpecifica meglio il nome.`;
            }
            const resolved = empMatches[0]?.googleEmail ?? empMatches[0]?.email;
            if (resolved) {
              toAddress = resolved;
            } else {
              const allEmps = await db.select({ name: employees.name, email: employees.email, googleEmail: employees.googleEmail }).from(employees).where(eq(employees.isActive, true));
              const empList = allEmps.map((e) => `- ${e.name}: ${e.googleEmail ?? e.email ?? "nessuna email"}`).join("\n");
              return `Dipendente "${searchName}" non trovato. Dipendenti disponibili:\n${empList}`;
            }
          } else {
            return "Specifica un destinatario (to o to_name).";
          }
        }
        const sent = await sendEmail(toAddress, input.subject, input.body, userAuth, input.cc);
        return sent
          ? `Email inviata a ${toAddress} con oggetto "${input.subject}".`
          : `Invio email fallito a ${toAddress} — verifica la configurazione Google (serve il scope gmail.send).`;
      }

      if (name === "update_task_status") {
        const matchingForStatus = await db.select().from(tasks)
          .where(sql`${tasks.title} ILIKE ${"%" + input.task_title + "%"}`).limit(5);
        if (!matchingForStatus.length) return `Task "${input.task_title}" non trovato.`;
        if (matchingForStatus.length > 1) {
          return `Trovati ${matchingForStatus.length} task corrispondenti:\n${matchingForStatus.map((t) => `- "${t.title}" (${t.status})`).join("\n")}\nSpecifica meglio il titolo.`;
        }
        const task = matchingForStatus[0];
        await db.update(tasks).set({ status: input.new_status, updatedAt: new Date() }).where(eq(tasks.id, task.id));

        // Sync status to Notion
        if (task.externalId?.startsWith("notion")) {
          const notionPageId = task.externalId.replace(/^notion(-done)?:/, "");
          updateNotionTaskStatus(notionPageId, input.new_status).catch((e) =>
            logger.error({ err: e, notionPageId }, "Notion status sync failed"),
          );
        }

        // Sync status to Google Tasks + cleanup calendar event
        if (input.new_status === "done" || input.new_status === "cancelled") {
          completeGoogleTask(task.id).catch((e) => logger.error({ err: e, taskId: task.id }, "Google Tasks complete failed"));
          if (task.calendarEventId) {
            deleteCalendarEvent(task.calendarEventId).catch((e) => logger.error({ err: e, eventId: task.calendarEventId }, "Calendar event delete on task complete/cancel failed"));
          }
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
          collectedFiles?.push({ buffer: pdf, filename: fileName });
          return `Report PDF per ${input.employee_name} generato.${driveFile && !collectedFiles?.length ? ` Salvato su Drive: ${driveFile.webViewLink}` : ""}`;
        }

        if (reportType === "weekly") {
          const now = new Date();
          const start = input.start_date ? new Date(input.start_date) : (() => { const d = new Date(now); d.setDate(d.getDate() - (d.getDay() === 0 ? 6 : d.getDay() - 1)); d.setHours(0,0,0,0); return d; })();
          const end = input.end_date ? new Date(input.end_date) : now;
          const pdf = await generateWeeklyReportPdf(start, end);
          const fileName = `weekly-report-${start.toISOString().split("T")[0]}.pdf`;
          const driveFile = await uploadFileToDrive(fileName, pdf, "application/pdf", config.DRIVE_DAILY_FOLDER_ID || undefined).catch(() => null);
          collectedFiles?.push({ buffer: pdf, filename: fileName });
          return `Report PDF settimanale generato.${driveFile && !collectedFiles?.length ? ` Salvato su Drive: ${driveFile.webViewLink}` : ""}`;
        }

        // daily
        const today = new Date().toISOString().split("T")[0];
        const [activeTasks, doneTasks, allMsgs, allEmpsForReport] = await Promise.all([
          db.select().from(tasks).where(inArray(tasks.status, ["pending", "in_progress"])),
          db.select().from(tasks).where(eq(tasks.status, "done")),
          db.select().from(messageLogs).where(sql`${messageLogs.receivedAt}::date = ${today}`),
          db.select({ id: employees.id, name: employees.name, accessRole: employees.accessRole }).from(employees).where(eq(employees.isActive, true)),
        ]);
        const empNameById = new Map(allEmpsForReport.map((e) => [e.id, e.name]));
        const overdueTasks = activeTasks.filter((t) => t.dueDate && new Date(t.dueDate) < new Date());

        // Fetch owner calendar + all employees' calendars and merge (deduplicate by event id)
        const [ownerEvts, teamEventsData, emails] = await Promise.all([
          getTodayEvents().catch(() => []),
          getTeamEvents().catch(() => []),
          getUnreadImportantEmails(5).catch(() => []),
        ]);
        const seenEventIds = new Set<string>(ownerEvts.map((e) => e.id));
        const calEvts = [...ownerEvts];
        for (const { events } of teamEventsData) {
          for (const e of events) {
            if (!seenEventIds.has(e.id)) { calEvts.push(e); seenEventIds.add(e.id); }
          }
        }

        const slackMsgs = allMsgs.filter((m) => m.source === "slack");
        const notionData = isNotionConfigured() ? await getNotionWorkspaceSummary().catch(() => null) : null;

        // Resolve owner name from DB (accessRole = 'owner')
        const ownerEmpRow = allEmpsForReport.find((e) => e.accessRole === "owner") ?? allEmpsForReport[0];
        const ownerName = ownerEmpRow?.name ?? "Owner";

        // Build calendar groups per person for PDF section and narrative
        const calendarByPerson: { person: string; events: { summary: string; start: string | null; end: string | null }[] }[] = [];
        if (ownerEvts.length) {
          calendarByPerson.push({ person: ownerName, events: ownerEvts.map((e) => ({ summary: e.summary, start: e.start ?? null, end: e.end ?? null })) });
        }
        for (const { employee: empName, events: empEvts } of teamEventsData) {
          const filtered = empEvts.filter((e) => !seenEventIds.has(e.id) === false || ownerEvts.every((o) => o.id !== e.id));
          if (filtered.length) {
            calendarByPerson.push({ person: empName, events: filtered.map((e) => ({ summary: e.summary, start: e.start ?? null, end: e.end ?? null })) });
          }
        }

        const narrative = await this.think(
          "Genera un report operativo giornaliero basato sui dati forniti. " +
          "Scrivi in modo narrativo, chiaro e strutturato. " +
          "Raggruppa gli eventi calendario per persona. " +
          "NON usare emoji, usa solo testo ASCII. " +
          "NON includere markup XML, tool calls, o tag tecnici — solo testo pulito.", {
          date: today,
          calendar_per_persona: calendarByPerson,
          important_emails: emails.map((e) => ({ from: e.from, subject: e.subject, snippet: e.snippet })),
          tasks: activeTasks.map((t) => ({ title: t.title, status: t.status, priority: t.priority, due: t.dueDate, assignee: empNameById.get(t.assignedTo ?? "") ?? null })),
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
          taskList: activeTasks.map((t) => ({ title: t.title, status: t.status, priority: t.priority, due: t.dueDate, assignee: empNameById.get(t.assignedTo ?? "") ?? null })),
          msgBySource: Array.from(srcCount, ([s, v]) => ({ label: s, value: v, color: srcColors[s] ?? "#888888" })),
          calendarByPerson,
        });
        const fileName = `daily-report-${today}.pdf`;
        const driveFile = await uploadFileToDrive(fileName, pdf, "application/pdf", config.DRIVE_DAILY_FOLDER_ID || undefined).catch(() => null);
        collectedFiles?.push({ buffer: pdf, filename: fileName });
        await db.insert(dailyReports).values({ reportDate: today, reportType: "on_demand", content: narrative });
        return `Report PDF giornaliero generato.${driveFile && !collectedFiles?.length ? ` Salvato su Drive: ${driveFile.webViewLink}` : ""}`;
      }

      if (name === "manage_team") {
        const action = input.action as string;
        if (action === "list_employees") {
          const allEmps = await db.select({ id: employees.id, name: employees.name, role: employees.role, email: employees.email }).from(employees).where(eq(employees.isActive, true));
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

          // Check for missing key fields — ask user to confirm before creating
          const notionMissingFields: string[] = [];
          if (!input.priority) notionMissingFields.push("priorita' (default: media)");
          if (!input.due_date) notionMissingFields.push("scadenza (default: nessuna)");
          if (!input.assignee) notionMissingFields.push("assegnatario (default: nessuno)");
          if (notionMissingFields.length >= 2 && !input.confirmed) {
            return `Prima di creare il task "${input.title}" su Notion, mancano alcune informazioni:\n` +
              notionMissingFields.map((f) => `- ${f}`).join("\n") +
              `\n\nVuoi procedere con i default o preferisci specificarli?`;
          }

          // Route to the correct Notion database based on section
          const section = (input.section as string | undefined) ?? "tasks";
          let url: string | null = null;
          if (section === "action_items") {
            url = await createNotionMeetingAction(input.title, {
              assignee: input.assignee, dueDate: input.due_date, notes: input.description,
            });
          } else if (section === "projects") {
            url = await createNotionProject(input.title);
          } else {
            url = await createNotionTask(input.title, {
              status: input.status, priority: input.priority, dueDate: input.due_date, assignee: input.assignee, description: input.description,
            });
          }

          // Mirror in internal DB so reminders/escalation/notifications work
          let notionAssignedTo: string | null = null;
          if (input.assignee) {
            const [empRow] = await db.select({ id: employees.id }).from(employees)
              .where(sql`${employees.name} ILIKE ${"%" + input.assignee + "%"}`).limit(1);
            notionAssignedTo = empRow?.id ?? null;
          }
          const notionDue = input.due_date ? parseLocalDate(input.due_date, input.timezone ?? userTz) : null;
          const notionPageId = url ? extractNotionPageId(url) : null;
          const [notionDbTask] = await db.insert(tasks).values({
            title: input.title,
            description: input.description ?? null,
            assignedTo: notionAssignedTo,
            dueDate: notionDue,
            priority: input.priority ?? "medium",
            // If Notion creation succeeded use "notion" source with externalId;
            // if it failed (url=null or pageId extraction failed), use "ai" so the
            // syncTasksToNotion cron can pick it up and retry.
            source: notionPageId ? "notion" : "ai",
            externalId: notionPageId ? `notion:${notionPageId}` : null,
            status: "pending",
          }).returning({ id: tasks.id });

          // Instant tiered notification
          if (notionAssignedTo && notionDue) {
            const [notifEmp] = await db
              .select({ name: employees.name, email: employees.email, googleEmail: employees.googleEmail, slackMemberId: employees.slackMemberId, timezone: employees.timezone })
              .from(employees).where(eq(employees.id, notionAssignedTo)).limit(1);
            if (notifEmp) {
              const notionHoursLeft = (notionDue.getTime() - Date.now()) / 3_600_000;
              const notionLevel = getTargetLevel(notionHoursLeft);
              sendTieredNotification(
                { id: notionDbTask?.id, title: input.title, priority: input.priority ?? "medium", description: null, dueDate: notionDue },
                notifEmp,
                "Nuova task assegnata",
              ).catch((e) => logger.error({ err: e }, "Notion task assignment notification failed"));
              // Mark reminderLevel so the cron doesn't re-send this checkpoint
              if (notionDbTask?.id && notionLevel > 0) {
                db.update(tasks).set({ reminderLevel: notionLevel }).where(eq(tasks.id, notionDbTask.id))
                  .catch((e) => logger.error({ err: e, taskId: notionDbTask.id }, "reminderLevel update failed (notion_action)"));
              }
            }
          }

          return url ? `Task Notion "${input.title}" creato: ${url}` : "Creazione task Notion fallita — verifica la configurazione.";
        }
        if (action === "update_task") {
          if (!input.title) return "Titolo del task richiesto per l'aggiornamento.";
          // Find task in internal DB by title to get Notion page ID
          const foundAll = await db.select({ id: tasks.id, externalId: tasks.externalId, title: tasks.title, autoScheduled: tasks.autoScheduled })
            .from(tasks)
            .where(ilike(tasks.title, `%${input.title}%`))
            .limit(5);
          if (foundAll.length > 1) {
            return `Trovati ${foundAll.length} task corrispondenti:\n${foundAll.map((t) => `- "${t.title}"`).join("\n")}\nSpecifica meglio il titolo.`;
          }
          const found = foundAll;
          const notionId = found[0]?.externalId?.replace(/^notion(-done)?:/, "");
          if (!notionId) return `Task "${input.title}" non trovato su Notion. Verifica che sia sincronizzato.`;

          const results: string[] = [];
          if (input.status) {
            const ok = await updateNotionTaskStatus(notionId, input.status);
            results.push(ok ? `status → "${input.status}"` : "aggiornamento status fallito");
          }
          if (input.priority || input.due_date || input.assignee || input.description) {
            const ok = await updateNotionTaskProperties(notionId, {
              priority: input.priority,
              dueDate: input.due_date,
              assignee: input.assignee,
              description: input.description,
            });
            if (input.priority) results.push(ok ? `priorità → "${input.priority}"` : "aggiornamento priorità fallito");
            if (input.due_date) results.push(ok ? `deadline → ${input.due_date}` : "aggiornamento deadline fallito");
            if (input.assignee) results.push(ok ? `assegnato a ${input.assignee}` : `assegnazione a ${input.assignee} fallita (utente Notion non trovato?)`);
            if (input.description) results.push(ok ? "descrizione aggiornata" : "aggiornamento descrizione fallito");
          }
          // Mirror changes to internal DB
          if (found[0]?.externalId) {
            const dbUpdates: Record<string, any> = { updatedAt: new Date() };
            const notionStatusMap: Record<string, string> = {
              "Not started": "pending", "In progress": "in_progress", "In Progress": "in_progress",
              "Done": "done", "Cancelled": "cancelled",
            };
            if (input.status) dbUpdates.status = notionStatusMap[input.status] ?? input.status.toLowerCase().replace(/\s+/g, "_");
            if (input.priority) dbUpdates.priority = input.priority.toLowerCase();
            if (input.due_date) dbUpdates.dueDate = parseLocalDate(input.due_date, input.timezone ?? userTz);
            if (input.assignee) {
              const [assigneeEmp] = await db.select({ id: employees.id }).from(employees)
                .where(sql`${employees.name} ILIKE ${"%" + input.assignee + "%"}`).limit(1);
              if (assigneeEmp) dbUpdates.assignedTo = assigneeEmp.id;
            }
            if (input.description) dbUpdates.description = input.description;
            if (Object.keys(dbUpdates).length > 1) {
              await db.update(tasks).set(dbUpdates).where(eq(tasks.externalId, found[0].externalId));
            }
            // Trigger reschedule if priority or deadline changed and task is auto-scheduled
            if ((input.priority || input.due_date) && found[0]?.autoScheduled && found[0]?.id) {
              await rescheduleTask(found[0].id).catch(() => {});
            }
            // Sync dueDate changes to Google Tasks
            if (input.due_date && found[0]?.id) {
              updateGoogleTask(found[0].id, {
                dueDate: parseLocalDate(input.due_date, input.timezone ?? userTz),
              }).catch(() => {});
            }
          }

          return results.length ? `Task Notion "${found[0]?.title}" aggiornato: ${results.join(", ")}.` : "Nessun campo da aggiornare specificato.";
        }
        if (action === "delete_task") {
          if (!input.title) return "Titolo del task richiesto per eliminare da Notion.";
          const foundAll = await db.select({ id: tasks.id, externalId: tasks.externalId, title: tasks.title })
            .from(tasks)
            .where(ilike(tasks.title, `%${input.title}%`))
            .limit(5);
          if (foundAll.length > 1) {
            return `Trovati ${foundAll.length} task corrispondenti:\n${foundAll.map((t) => `- "${t.title}"`).join("\n")}\nSpecifica meglio il titolo.`;
          }
          const found = foundAll;
          const notionId = found[0]?.externalId?.replace(/^notion(-done)?:/, "");

          const archivedTitles: string[] = [];

          // Archive via internal DB externalId (main Tasks DB)
          if (notionId) {
            const ok = await archiveNotionPage(notionId);
            if (ok) {
              archivedTitles.push(found[0]?.title ?? input.title);
              if (found[0]?.id) await db.delete(tasks).where(eq(tasks.id, found[0].id));
            }
          }

          // Fallback: search Notion directly to catch Meeting Actions or any untracked pages
          const notionResults = await searchNotion(input.title);
          for (const r of notionResults) {
            const pageId = extractNotionPageId(r.url);
            // Skip if already archived above
            if (pageId && pageId !== notionId) {
              const ok = await archiveNotionPage(pageId);
              if (ok) archivedTitles.push(r.title);
            }
          }

          if (archivedTitles.length > 0) {
            return `Eliminato da Notion: ${archivedTitles.map((t) => `"${t}"`).join(", ")}.`;
          }
          return `Task "${input.title}" non trovato su Notion.`;
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
        if (matchingTasks.length > 1 && (input.action === "edit" || input.action === "delete")) {
          return `Trovati ${matchingTasks.length} task corrispondenti:\n${matchingTasks.map((t) => `- "${t.title}" (${t.status})`).join("\n")}\nSpecifica meglio il titolo.`;
        }
        const task = matchingTasks[0];

        if (input.action === "delete") {
          for (const t of matchingTasks) {
            if (t.externalId?.startsWith("notion:")) {
              const notionPageId = t.externalId.replace(/^notion(-done)?:/, "");
              archiveNotionPage(notionPageId).catch((e) =>
                logger.error({ err: e, notionPageId }, "Notion archive on delete failed"),
              );
            } else if (isNotionConfigured()) {
              // No local externalId — search Notion by title and archive if found
              searchNotion(t.title).then((results) => {
                const match = results.find((r) => r.title.toLowerCase() === t.title.toLowerCase());
                if (match) {
                  const pageId = extractNotionPageId(match.url);
                  if (pageId) archiveNotionPage(pageId).catch(() => {});
                }
              }).catch(() => {});
            }
            deleteGoogleTask(t.id).catch(() => {});
            await db.delete(tasks).where(eq(tasks.id, t.id));
          }
          if (matchingTasks.length === 1) {
            return `Task "${matchingTasks[0].title}" eliminato.`;
          }
          return `${matchingTasks.length} task eliminati: ${matchingTasks.map((t) => `"${t.title}"`).join(", ")}.`;
        }

        const updates: Record<string, any> = { updatedAt: new Date() };
        if (input.new_title) updates.title = input.new_title;
        if (input.new_description) updates.description = input.new_description;
        if (input.new_priority) updates.priority = input.new_priority;
        if (input.new_due_date) {
          updates.dueDate = parseLocalDate(input.new_due_date, input.timezone ?? userTz);
          // Reset escalation level so the task re-escalates from scratch with the new deadline
          updates.escalationLevel = 0;
          updates.lastEscalatedAt = null;
        }
        if (input.new_assigned_to) {
          const [emp] = await db.select({ id: employees.id }).from(employees)
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
            dueDate: input.new_due_date ? parseLocalDate(input.new_due_date, input.timezone ?? userTz) : undefined,
          }).catch(() => {});
        }
        // Sync changes to Notion
        if (task.externalId?.startsWith("notion:")) {
          const notionPageId = task.externalId.replace(/^notion(-done)?:/, "");
          updateNotionTaskProperties(notionPageId, {
            title: input.new_title,
            priority: input.new_priority,
            dueDate: input.new_due_date,
            assignee: input.new_assigned_to,
            description: input.new_description,
          }).catch((e) => logger.error({ err: e, notionPageId }, "Notion property sync on edit failed"));
        }
        // Trigger reschedule if priority or deadline changed and task was scheduled
        if ((input.new_priority || input.new_due_date) && task.autoScheduled) {
          await rescheduleTask(task.id).catch(() => {});
        }
        return `Task "${task.title}" aggiornato con successo.${task.autoScheduled && (input.new_priority || input.new_due_date) ? " Il task verra' rischedulato nel calendario." : ""}`;
      }

      if (name === "get_calendar_events") {
        const displayTz = userTz || config.TIMEZONE;
        const formatEvents = (evs: Awaited<ReturnType<typeof getTodayEvents>>) =>
          evs.map((e) => {
            const start = e.start ? new Date(e.start).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", timeZone: displayTz }) : "TBD";
            const end = e.end ? new Date(e.end).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", timeZone: displayTz }) : "";
            return `  - ${start}${end ? `-${end}` : ""}: ${e.summary}${e.location ? ` (${e.location})` : ""}`;
          }).join("\n");

        const empName = (input.employee_name as string | undefined)?.toLowerCase().trim();
        if (empName && ["team", "all", "tutti", "everyone"].includes(empName)) {
          const teamEvents = await getTeamEvents();
          if (!teamEvents.length) return "Nessun dipendente con calendario configurato.";
          const lines: string[] = [];
          for (const { employee, events } of teamEvents) {
            lines.push(`**${employee}:**`);
            lines.push(events.length ? formatEvents(events) : "  Nessun evento.");
          }
          return lines.join("\n");
        }

        const requestedDate = (input.date as string | undefined) || undefined;
        const dateLabel = requestedDate ? new Date(requestedDate).toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long", timeZone: displayTz }) : "oggi";

        if (empName) {
          const [emp] = await db.select({ name: employees.name, googleRefreshToken: employees.googleRefreshToken })
            .from(employees)
            .where(sql`${employees.name} ILIKE ${"%" + input.employee_name + "%"}`)
            .limit(1);
          if (!emp?.googleRefreshToken) return `Calendario di "${input.employee_name}" non disponibile (Google non connesso).`;
          const empAuth = getUserGoogleAuth(emp.googleRefreshToken);
          const events = await getTodayEvents(empAuth, "primary", requestedDate);
          if (!events.length) return `Nessun evento nel calendario di ${emp.name} ${dateLabel}.`;
          return `**${emp.name}** (${dateLabel}):\n${formatEvents(events)}`;
        }

        const events = await getTodayEvents(userAuth, "primary", requestedDate);
        if (!events.length) return `Nessun evento in calendario per ${dateLabel}.`;
        return `**Calendario ${dateLabel}:**\n${formatEvents(events)}`;
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
          const [emp] = await db.select({ id: employees.id }).from(employees)
            .where(sql`${employees.name} ILIKE ${"%" + input.assigned_to_name + "%"}`).limit(1);
          if (!emp) {
            const allEmps = await db.select({ name: employees.name }).from(employees);
            const names = allEmps.map((e) => e.name).join(", ");
            return `Employee "${input.assigned_to_name}" non trovato. Dipendenti disponibili: ${names || "nessuno registrato"}.`;
          }
          assignedTo = emp.id;
        }

        await db.insert(tasks).values({
          title: input.title,
          description: input.description ?? null,
          priority: input.priority ?? "medium",
          assignedTo,
          isRecurring: true,
          recurrencePattern: input.pattern,
          recurrenceDays: input.days ?? null,
          recurrenceEndDate: input.end_date ? parseLocalDate(input.end_date, input.timezone ?? userTz) : null,
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

      if (name === "get_team_overview") {
        const now = new Date();
        const [teamEmployees, workload] = await Promise.all([
          db.select({ id: employees.id, name: employees.name, role: employees.role })
            .from(employees).where(eq(employees.isActive, true)),
          getTeamWorkload().catch(() => [] as WorkloadSummary[]),
        ]);
        if (!teamEmployees.length) return "Nessun dipendente attivo.";
        const empTasks = await Promise.all(teamEmployees.map(async (emp) => {
          const [activeRow] = await db.select({ count: sql<number>`count(*)` }).from(tasks)
            .where(and(eq(tasks.assignedTo, emp.id), inArray(tasks.status, ["pending", "in_progress"])));
          const [overdueRow] = await db.select({ count: sql<number>`count(*)` }).from(tasks)
            .where(and(eq(tasks.assignedTo, emp.id), inArray(tasks.status, ["pending", "in_progress"]), lt(tasks.dueDate, now)));
          return { id: emp.id, name: emp.name, role: emp.role, active: Number(activeRow?.count ?? 0), overdue: Number(overdueRow?.count ?? 0) };
        }));
        const workloadMap = new Map(workload.map((w) => [w.employeeName, w]));
        const lines = empTasks.map((e) => {
          const w = workloadMap.get(e.name);
          const pct = w ? `${Math.round(w.workloadScore * 100)}%` : "—";
          const overdueNote = e.overdue ? ` | ${e.overdue} scaduti` : "";
          return `• ${e.name} (${e.role}): ${pct} workload, ${e.active} task attivi${overdueNote}`;
        });
        return `Team Overview — ${now.toLocaleDateString("it-IT")}\n${lines.join("\n")}`;
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
                      description: task.description ?? "Auto-scheduled by COO Assistant",
                    },
                  });
                  await db.update(tasks).set({
                    scheduledStart: slot.start, scheduledEnd: slot.end,
                    autoScheduled: true, calendarEventId: ev.data.id, updatedAt: new Date(),
                  }).where(eq(tasks.id, task.id));
                  const tz = userTz || config.TIMEZONE || "Europe/Rome";
                  const time = slot.start.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", timeZone: tz });
                  const date = slot.start.toLocaleDateString("it-IT", { timeZone: tz });
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
              const tz2 = userTz || config.TIMEZONE || "Europe/Rome";
              const time = remaining.start.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", timeZone: tz2 });
              const date = remaining.start.toLocaleDateString("it-IT", { timeZone: tz2 });
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
        return getTopics(String(input.days ?? 7));
      }

      if (name === "get_meeting_intelligence") {
        return getMeetingStats();
      }

      if (name === "add_notion_comment") {
        const [task] = await db.select().from(tasks)
          .where(sql`${tasks.title} ILIKE ${"%" + input.task_title + "%"}`).limit(1);
        if (!task) return `Task "${input.task_title}" non trovato.`;
        if (!task.externalId?.startsWith("notion:")) return `Task "${task.title}" non ha un link Notion. Verra' sincronizzato al prossimo ciclo.`;
        const notionPageId = task.externalId.replace(/^notion(-done)?:/, "");
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
            dueDate: input.deadline ? parseLocalDate(input.deadline, input.timezone ?? userTz) : null,
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

      if (name === "create_google_doc") {
        const doc = await createGoogleDoc(input.title, input.content, undefined, userAuth);
        if (!doc) return "Impossibile creare il documento. Verifica la configurazione Google.";
        return `Documento creato: "${doc.title}"\n${doc.url}`;
      }

      if (name === "process_meeting_notes") {
        const result = await processMeetingDocById(input.doc_url, input.send_to);
        return result;
      }

      if (name === "brain_status") {
        return await getBrainStatus();
      }

      if (name === "query_brain") {
        return await queryBrain(input.query as string, input.category as string | undefined);
      }

      if (name === "add_brain_fact") {
        await addFactToBrain(input.fact as string, input.category as "team" | "project" | "client" | "process" | "decision" | undefined);
        return `Fatto aggiunto al cervello: "${input.fact}"`;
      }

      if (name === "resolve_decision") {
        return await resolveDecision(input.decision_text as string);
      }

      if (name === "unified_search") {
        const sourceFilter = input.source === "all" ? undefined : input.source;
        const results = await unifiedSearch(input.query, { source: sourceFilter, authOverride: userAuth });
        if (!results.length) return `Nessun risultato trovato per "${input.query}".`;
        return results.map((r) => `[${r.source}] ${r.title}\n  ${r.snippet}${r.url ? `\n  ${r.url}` : ""}`).join("\n\n");
      }

      if (name === "search_emails") {
        const results = await searchEmails(input.query, input.max_results ?? 5, userAuth);
        if (!results.length) return `Nessuna email trovata per "${input.query}".`;
        return results.map((e) => `ID: ${e.id}\nDa: ${e.from}\nOggetto: ${e.subject}\nData: ${e.date}\n${e.snippet}`).join("\n---\n");
      }

      if (name === "forward_email") {
        // Resolve recipient email
        let to = input.to;
        if (!to && input.to_name) {
          const [emp] = await db.select({ email: employees.email, googleEmail: employees.googleEmail })
            .from(employees)
            .where(sql`${employees.name} ILIKE ${"%" + input.to_name + "%"}`)
            .limit(1);
          to = emp?.email ?? emp?.googleEmail;
          if (!to) return `Employee "${input.to_name}" non trovato o senza email.`;
        }
        if (!to) return "Specifica un destinatario (to o to_name).";

        // Find the email
        if (!input.email_query) return "Specifica email_query per trovare l'email da inoltrare.";
        const emails = await searchEmails(input.email_query, 1, userAuth);
        if (!emails.length) return `Nessuna email trovata per "${input.email_query}".`;

        const sent = await forwardEmail(emails[0].id, to, input.note, userAuth);
        return sent
          ? `Email "${emails[0].subject}" inoltrata a ${to}.`
          : `Errore nell'inoltro dell'email.`;
      }

      if (name === "reply_email") {
        if (!input.email_query) return "Specifica email_query per trovare l'email a cui rispondere.";
        const emails = await searchEmails(input.email_query, 1, userAuth);
        if (!emails.length) return `Nessuna email trovata per "${input.email_query}".`;

        const sent = await replyToEmail(emails[0].id, input.body, input.reply_all ?? false, userAuth);
        return sent
          ? `Risposta inviata a "${emails[0].subject}"${input.reply_all ? " (reply all)" : ""}.`
          : `Errore nella risposta all'email.`;
      }

      if (name === "get_health_score") {
        const hs = await computeHealthScore();
        return formatHealthScore(hs) +
          `\n\nDettaglio componenti:\n• Completamento task (settimana): ${hs.components.completionRate}%\n• Task attivi non in ritardo: ${hs.components.overdueRatio}%\n• Bilanciamento carico team: ${hs.components.workloadBalance}%\n• Salute commitment aperti: ${hs.components.commitmentHealth}%`;
      }

      if (name === "get_recap") {
        const hours = Math.min(Math.max(1, input.hours ?? 24), 72);
        const since = new Date(Date.now() - hours * 60 * 60 * 1000);
        const [completedTasks, newTasks, slackMsgs, botActions] = await Promise.all([
          db.select({ title: tasks.title, assignedTo: tasks.assignedTo }).from(tasks)
            .where(and(eq(tasks.status, "done"), gte(tasks.updatedAt, since))),
          db.select({ title: tasks.title, priority: tasks.priority }).from(tasks)
            .where(gte(tasks.createdAt, since)).limit(20),
          db.select({ count: sql<number>`count(*)` }).from(messageLogs)
            .where(and(eq(messageLogs.source, "slack"), gte(messageLogs.receivedAt, since))),
          getRecentBotActions(10),
        ]);
        return this.think(
          `Genera un recap operativo conciso delle ultime ${hours} ore. Sii diretto e utile come un COO che fa il punto al founder. Max 500 caratteri.`,
          {
            period_hours: hours,
            tasks_completed: completedTasks.length,
            tasks_created: newTasks.length,
            slack_messages: Number(slackMsgs[0]?.count ?? 0),
            bot_actions: botActions.slice(0, 5).map((a) => `[${a.actionType}] ${a.description}`),
            completed_titles: completedTasks.slice(0, 5).map((t) => t.title),
            new_task_titles: newTasks.slice(0, 5).map((t) => `${t.title} (${t.priority})`),
          },
        );
      }

      if (name === "manage_notifications") {
        if (!slackUserId) return "Impossibile identificare l'utente per gestire le preferenze notifiche.";
        const action = (input.action ?? "list") as string;
        if (action === "list") {
          const muted = await getMutedTypes(slackUserId);
          const lines = ALL_NOTIF_TYPES.map((t) => `• \`${t}\` — ${muted.has(t) ? "🔕 silenziato" : "🔔 attivo"}`);
          return `*Preferenze Notifiche*\n\n${lines.join("\n")}\n\nPer modificarle chiedi es. "silenzia le escalation" o "riattiva i task_reminders".`;
        }
        if (!input.type || !ALL_NOTIF_TYPES.includes(input.type as any)) {
          return `Tipo non valido. Tipi disponibili: ${ALL_NOTIF_TYPES.join(", ")}`;
        }
        if (action === "mute") {
          await muteNotif(slackUserId, input.type);
          return `🔕 Notifiche \`${input.type}\` silenziate.`;
        }
        if (action === "unmute") {
          await unmuteNotif(slackUserId, input.type);
          return `🔔 Notifiche \`${input.type}\` riattivate.`;
        }
        return "Azione non valida. Usa: list, mute, unmute.";
      }

      if (name === "get_audit_log") {
        const limit = Math.min(Math.max(1, input.limit ?? 20), 50);
        const actions = await getRecentBotActions(limit);
        if (!actions.length) return "Nessuna azione autonoma registrata.";
        const lines = actions.map((a) => {
          const ts = a.detectedAt ? new Date(a.detectedAt).toLocaleString("it-IT", { timeZone: config.TIMEZONE || "Europe/Rome", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
          return `[${ts}] [${a.actionType}] ${a.description}`;
        });
        return `Azioni autonome recenti (${actions.length}):\n${lines.join("\n")}`;
      }

      if (name === "take_screenshot") {
        if (!input.url) return "URL richiesto per lo screenshot.";
        try {
          const buffer = await takeScreenshot(input.url, { fullPage: !!input.full_page });
          const filename = `screenshot-${Date.now()}.png`;
          collectedFiles?.push({ buffer, filename });
          return `Screenshot di ${input.url} catturato.`;
        } catch (err: any) {
          return `Screenshot fallito per ${input.url}: ${err.message}`;
        }
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
    userTz?: string,
  ): Promise<Record<string, unknown>> {
    const tz = userTz || config.TIMEZONE || "Europe/Rome";
    // Format current time in the user's local timezone (not UTC).
    // This lets the AI compute relative times like "tra 3 ore" without timezone math.
    const localNow = new Date().toLocaleString("sv-SE", { timeZone: tz }).replace(" ", "T");
    const context: Record<string, unknown> = {
      current_datetime: localNow, // e.g. "2026-03-30T15:30:00" in user's local time
      timezone: tz,
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
      db.select({ id: employees.id, name: employees.name, role: employees.role, accessRole: employees.accessRole }).from(employees).where(eq(employees.isActive, true)),
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
    userName?: string,
    chatId?: string,
  ): Promise<AgentResponse> {
    const collectedFiles: Array<{ buffer: Buffer; filename: string }> = [];

    // Resolve per-user Google auth. Owner falls back to global token; non-owners get null if no personal token.
    const userAuth = await getAuthForEmployee(employeeId, userRole === "owner");

    // Resolve per-user timezone
    let userTz: string | undefined;
    if (employeeId) {
      try {
        const [emp] = await db.select({ timezone: employees.timezone }).from(employees).where(eq(employees.id, employeeId)).limit(1);
        if (emp?.timezone) userTz = emp.timezone;
      } catch { /* fallback to config.TIMEZONE */ }
    }

    // Build context based on role
    const context = await this.buildContextForRole(query, userRole, employeeId, userAuth, userTz);

    // Filter tools based on role
    const allowedNames = getAllowedToolNames(userRole);
    const filteredTools = this.tools.filter((t) => allowedNames.has(t.name));

    // Build role-aware system prompt
    const rolePromptSuffix = userRole === "owner" ? "" :
      userRole === "admin"
        ? "\n\nL'utente ha ruolo ADMIN. Puo' creare/modificare task, inviare messaggi, generare report. NON puo' accedere a: sentiment team, communication patterns, commitments, knowledge base, gestione team. Se chiede queste cose, rispondi che non ha i permessi."
        : "\n\nL'utente ha ruolo VIEWER. Puo' SOLO consultare i propri task e il calendario. NON puo' creare/modificare task, inviare messaggi, vedere email, slack, report, o dati di altri employee. Se chiede queste cose, rispondi che non ha i permessi.";

    // Load long-term user memories (preferences, patterns) and inject into system prompt
    const memories = chatId ? await getUserMemories(chatId) : [];
    const memoriesPrompt = formatMemoriesForPrompt(memories);
    const brainContext = await loadBrainContext();
    const fullSystemPrompt = COO_SYSTEM_PROMPT + rolePromptSuffix + memoriesPrompt + brainContext;

    // --- Tool use loop ---
    const userInfo = userName ? `[Messaggio da: ${userName} (${userRole})]\n` : "";

    // Auto-surface open commitments so Claude is proactively aware without being asked
    let commitmentSuffix = "";
    try {
      const openCommits = await db
        .select({ content: intelligenceEvents.content, channel: intelligenceEvents.channel })
        .from(intelligenceEvents)
        .where(and(eq(intelligenceEvents.type, "commitment"), eq(intelligenceEvents.status, "open")))
        .limit(3);
      if (openCommits.length) {
        commitmentSuffix = `\n\n\u26A0\uFE0F COMMITMENT APERTI (${openCommits.length}):\n` +
          openCommits.map((c) => `- "${c.content.slice(0, 80)}" (da ${c.channel ?? "?"})`).join("\n");
      }
    } catch { /* non-critical — skip silently */ }

    const contextStr = `${userInfo}Context:\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\`\n\n${query}${commitmentSuffix}`;

    // Build messages: recent history + current message
    // Summary injection is handled by compressConversationIfNeeded (avoids double-injection)
    const history = chatId ? await getConversationHistory(chatId) : [];

    let messages: any[] = [
      ...history.map((e) => ({ role: e.role, content: e.content })),
      { role: "user", content: contextStr },
    ];

    // Inject summary and/or compress if approaching context window limits
    if (chatId) {
      const compressed = await compressConversationIfNeeded(
        chatId, this.client, this.model, fullSystemPrompt, messages, filteredTools,
      );
      messages = compressed.messages;
      if (compressed.compressed) {
        sendOwnerNotification(
          `🗜️ *Compressione contesto* per *${userName ?? chatId}*\n` +
          `Token: ${compressed.tokensBefore?.toLocaleString() ?? "?"} → ~${compressed.tokensAfter?.toLocaleString() ?? "?"}\n` +
          `Messaggi compressi: ${compressed.messagesCompressed ?? "?"}`,
        ).catch(() => {});
      }
    }
    let textParts: string[] = [];

    for (let i = 0; i < 5; i++) { // max 5 tool call rounds
      let response: Awaited<ReturnType<Anthropic["messages"]["create"]>>;
      try {
        response = await this.client.messages.create({
          model: this.model,
          max_tokens: 4096,
          system: fullSystemPrompt,
          tools: filteredTools,
          messages,
        });
      } catch (err) {
        logger.error({ err }, "Claude API error in tool loop");
        if (textParts.length) break; // return accumulated text
        throw err; // re-throw if nothing accumulated yet
      }

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
          const result = await this.executeTool(block.name, block.input as Record<string, any>, userAuth, userTz, collectedFiles, chatId);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
        }
      }

      messages = [
        ...messages,
        { role: "assistant", content: response.content },
        { role: "user", content: toolResults },
      ];
    }

    const rawResponse = textParts.join("\n") || "Operazione completata.";
    // Strip raw AI markup artifacts that sometimes leak into text blocks
    const responseText = rawResponse
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
      .replace(/<assistant_response>|<\/assistant_response>/g, "")
      .replace(/<function_calls>[\s\S]*?<\/antml:function_calls>/g, "")
      .replace(/<tool_result>[\s\S]*?<\/tool_result>/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim() || "Operazione completata.";

    if (chatId) {
      // Persist query + response in conversation history (Redis or in-memory)
      await addToConversation(chatId, "user", query);
      await addToConversation(chatId, "assistant", responseText);
      // Extract and save long-term preferences in background — does not block response
      extractAndSaveMemories(chatId, query, responseText)
        .catch((e) => logger.error({ err: e }, "Memory extraction failed"));
    }

    return {
      text: responseText,
      files: collectedFiles.length ? collectedFiles : undefined,
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
