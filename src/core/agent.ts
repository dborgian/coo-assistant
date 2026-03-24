import Anthropic from "@anthropic-ai/sdk";
import { eq, inArray } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../models/database.js";
import { clients, employees, tasks } from "../models/schema.js";
import { logger } from "../utils/logger.js";
import { getTodayEvents } from "../services/calendar-sync.js";
import { getUnreadImportantEmails } from "../services/email-manager.js";

const COO_SYSTEM_PROMPT = `\
You are the Chief Operating Officer (COO) AI assistant for a high-performance startup.

Your responsibilities:
- Monitor all communication channels and flag messages needing the founder's attention
- Track tasks, deadlines, and remind team members of their responsibilities
- Generate daily operations reports covering calendar, tasks, emails, and client status
- Manage employee and client information
- Proactively identify operational issues before they become problems
- Communicate clearly and concisely via Telegram

Your personality:
- Professional but approachable
- Proactive — don't wait to be asked, surface issues early
- Concise — founders are busy, get to the point
- Detail-oriented — nothing falls through the cracks
- High standards — operate like a top-tier startup COO

When generating reports or summaries, use clear formatting with sections and bullet points.
When notifying about urgent matters, lead with the urgency level.

IMPORTANT: The context data provided with each query is LIVE data already fetched from integrated services.
- If "calendar_events_today" is an empty array, it means there are NO meetings today (the calendar IS connected).
- If "unread_important_emails" is an empty array, it means there are no important unread emails (Gmail IS connected).
- NEVER say you "don't have access" or "need to connect" — the integrations are already active.
- Answer based on the data provided. An empty array means "none", not "unavailable".

You have access to the following data sources:
- Google Calendar (today's events are provided in context)
- Gmail (important unread emails are provided in context)
- Internal database (employees, clients, tasks, message logs)
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
    const prompt = `Generate a concise daily operations report based on the following data.
Format it nicely for Telegram (use bold, bullet points).

Data:
${JSON.stringify(data, null, 2)}

Include sections for:
1. Today's Calendar (events, conflicts)
2. Important Emails (unread, needing attention)
3. Active Tasks & Deadlines
4. Messages Needing Attention
5. Overdue Items
6. Key Metrics / Status

If any section has no data, note it briefly and move on.`;

    return this.think(prompt);
  }

  async answerQuery(query: string): Promise<string> {
    const allEmployees = db
      .select()
      .from(employees)
      .where(eq(employees.isActive, true))
      .all();

    const allClients = db
      .select()
      .from(clients)
      .where(eq(clients.isActive, true))
      .all();

    const activeTasks = db
      .select()
      .from(tasks)
      .where(inArray(tasks.status, ["pending", "in_progress"]))
      .all();

    // Fetch calendar and email data
    const [calendarEvents, importantEmails] = await Promise.all([
      getTodayEvents().catch(() => []),
      getUnreadImportantEmails(5).catch(() => []),
    ]);

    const context = {
      today: new Date().toISOString().split("T")[0],
      integrations: {
        google_calendar: "connected — data below is live from Google Calendar",
        gmail: "connected — data below is live from Gmail",
      },
      employees: allEmployees.map((e) => ({
        id: e.id,
        name: e.name,
        role: e.role,
      })),
      clients: allClients.map((c) => ({
        id: c.id,
        name: c.name,
        company: c.company,
      })),
      active_tasks: activeTasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        due: t.dueDate,
      })),
      calendar_events_today: calendarEvents.map((e) => ({
        summary: e.summary,
        start: e.start,
        end: e.end,
        location: e.location,
      })),
      unread_important_emails: importantEmails.map((e) => ({
        from: e.from,
        subject: e.subject,
        snippet: e.snippet,
      })),
    };

    return this.think(query, context);
  }
}

export const agent = new COOAgent();
