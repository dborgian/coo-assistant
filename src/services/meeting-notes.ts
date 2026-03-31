import { google } from "googleapis";
import { eq, and, sql } from "drizzle-orm";
import { agent } from "../core/agent.js";
import { config } from "../config.js";
import { db } from "../models/database.js";
import { intelligenceEvents, employees } from "../models/schema.js";
import { getGoogleAuth, isGoogleConfigured } from "../core/google-auth.js";
import { sendEmail, getEmailBody, markEmailAsRead } from "./email-manager.js";
import { createNotionMeetingAction } from "./notion-sync.js";
import { readGoogleDocText } from "./google-docs-manager.js";
import { sendSlackMessage, getNotificationsChannel } from "../bot/slack-monitor.js";
import { logger } from "../utils/logger.js";

interface ActionItem {
  title: string;
  assignee?: string;
  dueDate?: string;
}

interface ParsedNotes {
  summary: string;
  actionItems: ActionItem[];
}

async function isAlreadyProcessed(calendarEventId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: intelligenceEvents.id })
    .from(intelligenceEvents)
    .where(
      and(
        eq(intelligenceEvents.type, "meeting_notes"),
        sql`${intelligenceEvents.metadata}->>'calendarEventId' = ${calendarEventId}`,
      ),
    )
    .limit(1);
  return !!row;
}

async function markAsProcessed(calendarEventId: string, driveFileId: string, meetingTitle: string): Promise<void> {
  await db.insert(intelligenceEvents).values({
    type: "meeting_notes",
    content: meetingTitle,
    status: "active",
    metadata: { calendarEventId, driveFileId },
  });
}

async function parseNotesWithAI(docContent: string, meetingTitle: string, attendeeNames: string): Promise<ParsedNotes | null> {
  const prompt = `Analizza queste note di meeting e restituisci un JSON con questa struttura esatta:
{"summary": "riassunto in 2-3 frasi", "actionItems": [{"title": "cosa fare", "assignee": "nome o null", "dueDate": "YYYY-MM-DD o null"}]}

Meeting: ${meetingTitle}
Partecipanti: ${attendeeNames}

NOTE:
${docContent.slice(0, 6000)}

Rispondi SOLO con il JSON, nessun testo prima o dopo.`;

  try {
    const raw = await agent.think(prompt);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]) as ParsedNotes;
  } catch (err) {
    logger.warn({ err }, "Failed to parse meeting notes JSON");
    return null;
  }
}

async function findGeminiDoc(auth: any, event: any): Promise<string | null> {
  // Primary: check Calendar event attachments (Gemini notes)
  const attachments: any[] = event.attachments ?? [];
  const geminiDoc = attachments.find(
    (a: any) => a.mimeType === "application/vnd.google-apps.document",
  );
  if (geminiDoc?.fileId) return geminiDoc.fileId;

  // Fallback: search Drive for a Doc created in the last 3 hours matching meeting title
  try {
    const drive = google.drive({ version: "v3", auth });
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const safeTitle = (event.summary ?? "").replace(/'/g, "\\'").slice(0, 60);
    const driveRes = await drive.files.list({
      q: `name contains '${safeTitle}' and mimeType = 'application/vnd.google-apps.document' and createdTime > '${threeHoursAgo}'`,
      fields: "files(id, name)",
      pageSize: 3,
    });
    return driveRes.data.files?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

async function sendMeetingEmail(
  attendeeEmails: string[],
  meetingTitle: string,
  dateStr: string,
  parsed: ParsedNotes,
): Promise<void> {
  const actionItemsText = parsed.actionItems.length
    ? parsed.actionItems
        .map((a, i) => {
          let line = `${i + 1}. ${a.title}`;
          if (a.assignee) line += ` — ${a.assignee}`;
          if (a.dueDate) line += ` (scade ${a.dueDate})`;
          return line;
        })
        .join("\n")
    : "Nessun action item identificato.";

  const body = `Ciao,

di seguito il riepilogo del meeting "${meetingTitle}" del ${dateStr}.

─────────────────────────────
RIASSUNTO
─────────────────────────────
${parsed.summary}

─────────────────────────────
ACTION ITEMS
─────────────────────────────
${actionItemsText}

─────────────────────────────

Questo messaggio è stato generato automaticamente dal COO Assistant.`;

  const subject = `Riepilogo meeting — ${meetingTitle} — ${dateStr}`;

  for (const email of attendeeEmails) {
    await sendEmail(email, subject, body).catch((err) =>
      logger.warn({ err, email }, "Failed to send meeting summary email"),
    );
  }
}

/** Extract Google Doc ID from a URL or return the raw ID if already clean. */
function extractDocId(urlOrId: string): string {
  const match = urlOrId.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
  return match ? match[1] : urlOrId.trim();
}

/**
 * Process a specific Google Doc as meeting notes — manual trigger.
 * Reads the doc, extracts info via AI, sends emails, creates Notion tasks.
 * Returns a human-readable status message.
 */
export async function processMeetingDocById(docUrlOrId: string): Promise<string> {
  if (!isGoogleConfigured()) return "Google non configurato.";

  const auth = getGoogleAuth();
  if (!auth) return "Auth Google non disponibile.";

  const docId = extractDocId(docUrlOrId);

  const docContent = await readGoogleDocText(docId, auth);
  if (!docContent || docContent.length < 30) {
    return "Documento vuoto o non accessibile. Verifica che il bot abbia accesso al Doc.";
  }

  // Let AI extract all metadata from the doc itself
  const metaPrompt = `Analizza queste note di meeting e restituisci JSON con questa struttura esatta:
{"meetingTitle": "titolo meeting", "date": "YYYY-MM-DD o null", "attendees": ["nome1", "nome2"], "summary": "riassunto in 2-3 frasi", "actionItems": [{"title": "cosa fare", "assignee": "nome o null", "dueDate": "YYYY-MM-DD o null"}]}

NOTE:
${docContent.slice(0, 6000)}

Rispondi SOLO con il JSON.`;

  let parsed: any;
  try {
    const raw = await agent.think(metaPrompt);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return "Impossibile analizzare il documento con AI.";
    parsed = JSON.parse(match[0]);
  } catch {
    return "Errore nel parsing AI delle note.";
  }

  const title: string = parsed.meetingTitle ?? "Meeting";
  const dateStr: string = parsed.date
    ? new Date(parsed.date).toLocaleDateString("it-IT")
    : new Date().toLocaleDateString("it-IT");
  const dateISO: string = parsed.date ?? new Date().toISOString().split("T")[0];
  const attendeeNames: string = (parsed.attendees ?? []).join(", ");
  const actionItems: ActionItem[] = parsed.actionItems ?? [];
  const summary: string = parsed.summary ?? "";

  // Send email if we have attendee emails in the doc
  // (attendees from AI are names, not emails — skip email for manual trigger unless user provides)
  // Instead we create Notion tasks and post Slack summary

  let notionCount = 0;
  if (config.NOTION_MEETING_ACTIONS_DATABASE_ID) {
    for (const item of actionItems) {
      await createNotionMeetingAction(item.title, {
        meetingTitle: title,
        meetingDate: dateISO,
        assignee: item.assignee ?? undefined,
        dueDate: item.dueDate ?? undefined,
        notes: `Meeting del ${dateStr} — ${summary}`,
      }).catch(() => {});
      notionCount++;
    }
  }

  // Slack notification
  const notifCh = getNotificationsChannel();
  if (notifCh) {
    const actionsList = actionItems.length
      ? actionItems.map((a) => `• ${a.title}${a.assignee ? ` (${a.assignee})` : ""}`).join("\n")
      : "_Nessun action item_";
    await sendSlackMessage(
      notifCh,
      `📋 *Meeting (manuale): ${title}* — ${dateStr}\n_${attendeeNames}_\n\n*Riassunto:* ${summary}\n\n*Action items:*\n${actionsList}`,
    ).catch(() => {});
  }

  logger.info({ docId, title, actions: actionItems.length }, "Meeting doc processed manually");

  const lines = [
    `✅ *${title}* — ${dateStr}`,
    `👥 Partecipanti: ${attendeeNames || "non rilevati"}`,
    ``,
    `*Riassunto:* ${summary}`,
    ``,
    `*Action items creati su Notion (${notionCount}):*`,
    ...actionItems.map((a) => `• ${a.title}${a.assignee ? ` → ${a.assignee}` : ""}${a.dueDate ? ` (${a.dueDate})` : ""}`),
    ...(actionItems.length === 0 ? ["_Nessun action item trovato nel documento._"] : []),
  ];
  return lines.join("\n");
}

/**
 * Check for Google Meet meetings that ended recently, read Gemini notes,
 * send email summary to attendees, and create Notion action items.
 * Scheduled every 30 minutes.
 */
export async function checkRecentMeetings(): Promise<void> {
  if (!isGoogleConfigured()) return;

  const auth = getGoogleAuth();
  if (!auth) return;

  const calendar = google.calendar({ version: "v3", auth });
  const now = new Date();
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

  try {
    const res = await calendar.events.list({
      calendarId: "primary",
      timeMin: twoHoursAgo.toISOString(),
      timeMax: now.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      timeZone: config.TIMEZONE,
    });

    const events = res.data.items ?? [];

    for (const event of events) {
      if (!event.id) continue;

      // Only process Google Meet events
      if (!event.conferenceData) continue;

      const endTime = event.end?.dateTime ? new Date(event.end.dateTime) : null;
      if (!endTime || endTime > now) continue;

      // Skip already processed
      if (await isAlreadyProcessed(event.id)) continue;

      const title = event.summary ?? "Meeting";
      const dateStr = endTime.toLocaleDateString("it-IT");
      const dateISO = endTime.toISOString().split("T")[0];

      // Attendees: emails for sending, names for AI context
      const attendees = event.attendees ?? [];
      const attendeeEmails = attendees
        .map((a: any) => a.email as string)
        .filter((e: string) => e && !e.includes("resource.calendar.google.com"));
      const attendeeNames = attendees
        .map((a: any) => a.displayName ?? a.email ?? "?")
        .join(", ");

      // Find Gemini notes Doc
      const docId = await findGeminiDoc(auth, event);
      if (!docId) {
        logger.debug({ meeting: title }, "No Gemini notes Doc found — skipping");
        continue;
      }

      // Read Doc content
      const docContent = await readGoogleDocText(docId, auth);
      if (!docContent || docContent.length < 50) {
        logger.debug({ meeting: title, docId }, "Doc content too short — notes may not be ready yet");
        continue;
      }

      // Mark as processed BEFORE heavy operations to prevent duplicate runs
      await markAsProcessed(event.id, docId, title);

      // Parse notes with Claude
      const parsed = await parseNotesWithAI(docContent, title, attendeeNames);
      if (!parsed) {
        logger.warn({ meeting: title }, "Failed to parse meeting notes — skipping email/Notion");
        continue;
      }

      // Send email to all attendees
      if (attendeeEmails.length > 0) {
        await sendMeetingEmail(attendeeEmails, title, dateStr, parsed);
      }

      // Create Notion action items in Meeting Actions DB
      if (config.NOTION_MEETING_ACTIONS_DATABASE_ID) {
        for (const item of parsed.actionItems) {
          await createNotionMeetingAction(item.title, {
            meetingTitle: title,
            meetingDate: dateISO,
            assignee: item.assignee ?? undefined,
            dueDate: item.dueDate ?? undefined,
            notes: `Meeting del ${dateStr} — ${parsed.summary}`,
          }).catch((err) => logger.warn({ err, item: item.title }, "Failed to create Notion meeting action"));
        }
      }

      // Slack notification summary
      const notifCh = getNotificationsChannel();
      if (notifCh) {
        const actionsList = parsed.actionItems.length
          ? parsed.actionItems.map((a) => `• ${a.title}${a.assignee ? ` (${a.assignee})` : ""}`).join("\n")
          : "_Nessun action item_";
        await sendSlackMessage(
          notifCh,
          `📋 *Meeting: ${title}* — ${dateStr}\n_${attendeeNames}_\n\n*Riassunto:* ${parsed.summary}\n\n*Action items:*\n${actionsList}`,
        ).catch(() => {});
      }

      logger.info(
        { meeting: title, docId, attendees: attendeeEmails.length, actions: parsed.actionItems.length },
        "Meeting notes processed",
      );
    }
  } catch (err) {
    logger.error({ err }, "Failed to check recent meetings");
  }

  // Also check Gmail for Gemini meeting notes emails
  await checkMeetingNotesEmails();
}

/**
 * Monitor Gmail for emails from Google Meet Gemini ("Meeting notes: ...").
 * Extracts the Doc link, processes notes, and marks the email as read.
 */
async function checkMeetingNotesEmails(): Promise<void> {
  if (!isGoogleConfigured()) return;

  const auth = getGoogleAuth();
  if (!auth) return;

  const gmail = google.drive({ version: "v3", auth }) as any; // reuse auth
  const gmailClient = google.gmail({ version: "v1", auth });

  try {
    const res = await gmailClient.users.messages.list({
      userId: "me",
      q: 'from:meet-recordings-noreply@google.com subject:"Meeting notes" is:unread',
      maxResults: 10,
    });

    const messages = res.data.messages ?? [];

    for (const msg of messages) {
      if (!msg.id) continue;

      const body = await getEmailBody(msg.id, auth);
      if (!body) { await markEmailAsRead(msg.id, auth); continue; }

      // Extract Google Doc URL from email body
      const docMatch = body.match(/https:\/\/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]{20,})/);
      if (!docMatch) { await markEmailAsRead(msg.id, auth); continue; }

      const docId = docMatch[1];

      // Skip if already processed by driveFileId
      const [existing] = await db
        .select({ id: intelligenceEvents.id })
        .from(intelligenceEvents)
        .where(
          and(
            eq(intelligenceEvents.type, "meeting_notes"),
            sql`${intelligenceEvents.metadata}->>'driveFileId' = ${docId}`,
          ),
        )
        .limit(1);

      if (existing) {
        await markEmailAsRead(msg.id, auth);
        continue;
      }

      logger.info({ docId, messageId: msg.id }, "Found Gemini meeting notes email — processing");

      await processMeetingDocById(docId);
      await markEmailAsRead(msg.id, auth);
    }
  } catch (err) {
    logger.error({ err }, "Failed to check meeting notes emails");
  }
}
