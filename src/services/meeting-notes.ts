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
import { feedMeetingToBrain, extractAndSaveFacts } from "./company-brain.js";
import { logger } from "../utils/logger.js";

interface ActionItem {
  title: string;
  assignee?: string;
  dueDate?: string;
  priority?: "high" | "medium" | "low";
  context?: string; // why this matters
}

interface ParsedNotes {
  meetingTitle?: string;
  date?: string;
  attendees?: string[];
  meetingType?: string; // standup, planning, client call, retrospective, etc.
  summary: string;
  keyDecisions: string[];
  actionItems: ActionItem[];
  openQuestions: string[];
  nextMeetingDate?: string;
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

async function markAsProcessed(
  calendarEventId: string,
  driveFileId: string,
  meetingTitle: string,
  fullData?: {
    date?: string;
    attendees?: string[];
    keyDecisions?: string[];
    actionItems?: Array<{ title: string; assignee?: string; dueDate?: string; priority?: string }>;
    openQuestions?: string[];
    summary?: string;
  },
): Promise<void> {
  await db.insert(intelligenceEvents).values({
    type: "meeting_notes",
    content: fullData?.summary ? `${meetingTitle}: ${fullData.summary.slice(0, 200)}` : meetingTitle,
    status: "active",
    metadata: {
      calendarEventId, driveFileId, title: meetingTitle,
      date: fullData?.date,
      attendees: fullData?.attendees,
      keyDecisions: fullData?.keyDecisions,
      actionItems: fullData?.actionItems,
      openQuestions: fullData?.openQuestions,
    },
  });
}

async function parseNotesWithAI(docContent: string, meetingTitle: string, attendeeNames: string): Promise<ParsedNotes | null> {
  const prompt = `Sei un assistente COO esperto nell'analisi di meeting aziendali. Analizza queste note e restituisci un JSON strutturato.

REGOLE:
- summary: 2-4 frasi che spiegano COSA è stato discusso e PERCHÉ era importante
- keyDecisions: solo decisioni concrete prese (non argomenti discussi) — array vuoto se nessuna
- actionItems: solo impegni CONCRETI con un responsabile chiaro. Per ogni item:
  * title: azione specifica e misurabile (non vaga)
  * assignee: nome della persona responsabile (null se non specificato)
  * dueDate: scadenza YYYY-MM-DD se menzionata (null altrimenti)
  * priority: "high" se urgente/bloccante, "medium" se importante, "low" se nice-to-have
  * context: una frase che spiega PERCHÉ questo task è necessario e il suo impatto
- openQuestions: domande rimaste aperte o punti da chiarire in futuro
- meetingType: tipo di meeting (standup/planning/retrospective/client_call/strategy/1on1/altro)
- nextMeetingDate: data prossimo meeting YYYY-MM-DD se menzionata

STRUTTURA JSON:
{
  "meetingTitle": "${meetingTitle}",
  "attendees": [${attendeeNames ? attendeeNames.split(", ").map((n) => JSON.stringify(n)).join(", ") : ""}],
  "meetingType": "...",
  "summary": "...",
  "keyDecisions": ["...", "..."],
  "actionItems": [
    {"title": "...", "assignee": "...", "dueDate": "...", "priority": "high|medium|low", "context": "..."}
  ],
  "openQuestions": ["...", "..."],
  "nextMeetingDate": null
}

Meeting: ${meetingTitle}
Partecipanti: ${attendeeNames}

NOTE:
${docContent.slice(0, 8000)}

Rispondi SOLO con il JSON valido, nessun testo prima o dopo.`;

  try {
    const raw = await agent.think(prompt);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as ParsedNotes;
    // Ensure required fields exist
    if (!parsed.summary) return null;
    if (!parsed.keyDecisions) parsed.keyDecisions = [];
    if (!parsed.actionItems) parsed.actionItems = [];
    if (!parsed.openQuestions) parsed.openQuestions = [];
    return parsed;
  } catch (err) {
    logger.warn({ err }, "Failed to parse meeting notes JSON");
    return null;
  }
}

/** Search Gmail for the latest unprocessed Gemini meeting notes email. Returns Doc ID or null. */
async function findLatestMeetingNotesDoc(): Promise<{ docId: string; messageId: string } | null> {
  const auth = getGoogleAuth();
  if (!auth) return null;

  const gmail = google.gmail({ version: "v1", auth });
  try {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: 'subject:"Meeting notes" is:unread',
      maxResults: 5,
    });

    const messages = res.data.messages ?? [];
    for (const msg of messages) {
      if (!msg.id) continue;
      const body = await getEmailBody(msg.id, auth);
      if (!body) continue;
      const docMatch = body.match(/https:\/\/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]{20,})/);
      if (!docMatch) continue;
      const docId = docMatch[1];
      // Check if already processed
      const [existing] = await db
        .select({ id: intelligenceEvents.id })
        .from(intelligenceEvents)
        .where(and(eq(intelligenceEvents.type, "meeting_notes"), sql`${intelligenceEvents.metadata}->>'driveFileId' = ${docId}`))
        .limit(1);
      if (existing) continue;
      return { docId, messageId: msg.id };
    }
    return null;
  } catch (err) {
    logger.error({ err }, "Failed to search for meeting notes emails");
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
  const priorityLabel: Record<string, string> = { high: "🔴 Alta", medium: "🟡 Media", low: "🟢 Bassa" };

  const actionItemsText = parsed.actionItems.length
    ? parsed.actionItems
        .map((a, i) => {
          let line = `${i + 1}. ${a.title}`;
          if (a.assignee) line += ` → ${a.assignee}`;
          if (a.dueDate) line += ` (scade ${a.dueDate})`;
          if (a.priority) line += ` [${priorityLabel[a.priority] ?? a.priority}]`;
          if (a.context) line += `\n   ↳ ${a.context}`;
          return line;
        })
        .join("\n")
    : "Nessun action item identificato.";

  const decisionsText = parsed.keyDecisions?.length
    ? parsed.keyDecisions.map((d, i) => `${i + 1}. ${d}`).join("\n")
    : "Nessuna decisione formale.";

  const openQuestionsText = parsed.openQuestions?.length
    ? parsed.openQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")
    : "";

  const body = [`Ciao,

di seguito il riepilogo del meeting "${meetingTitle}" del ${dateStr}.

─────────────────────────────
RIASSUNTO
─────────────────────────────
${parsed.summary}

─────────────────────────────
DECISIONI PRESE
─────────────────────────────
${decisionsText}

─────────────────────────────
ACTION ITEMS
─────────────────────────────
${actionItemsText}`,
    openQuestionsText ? `\n─────────────────────────────\nDOMANDE APERTE\n─────────────────────────────\n${openQuestionsText}` : "",
    parsed.nextMeetingDate ? `\n📅 Prossimo meeting: ${parsed.nextMeetingDate}` : "",
    "\n─────────────────────────────\n\nQuesto messaggio è stato generato automaticamente dal COO Assistant.",
  ].join("");

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
export async function processMeetingDocById(docUrlOrId?: string, sendTo?: string): Promise<string> {
  if (!isGoogleConfigured()) return "Google non configurato.";

  const auth = getGoogleAuth();
  if (!auth) return "Auth Google non disponibile.";

  // Auto-discovery: if no URL provided, find the latest unprocessed meeting notes email
  let resolvedDocId: string;
  let autoFoundMessageId: string | null = null;

  if (!docUrlOrId) {
    const found = await findLatestMeetingNotesDoc();
    if (!found) return "Nessun meeting notes email non processato trovato in Gmail. Passa un URL del Google Doc.";
    resolvedDocId = found.docId;
    autoFoundMessageId = found.messageId;
  } else {
    resolvedDocId = extractDocId(docUrlOrId);
  }

  // Deduplication guard for explicit doc IDs
  if (docUrlOrId) {
    const [existing] = await db
      .select({ id: intelligenceEvents.id })
      .from(intelligenceEvents)
      .where(
        and(
          eq(intelligenceEvents.type, "meeting_notes"),
          sql`${intelligenceEvents.metadata}->>'driveFileId' = ${resolvedDocId}`,
        ),
      )
      .limit(1);
    if (existing) return "Questo meeting è già stato processato in precedenza.";
  }

  const docContent = await readGoogleDocText(resolvedDocId, auth);
  if (!docContent || docContent.length < 30) {
    return "Documento vuoto o non accessibile. Verifica che il bot abbia accesso al Doc.";
  }

  // Extract title from first non-empty line if not known
  const firstLine = docContent.split("\n").find((l) => l.trim().length > 0)?.trim() || "Meeting Notes";

  // Parse with the improved AI prompt
  const parsed = await parseNotesWithAI(docContent, firstLine, "");
  if (!parsed) return "Impossibile analizzare il documento con AI.";

  const title = parsed.meetingTitle ?? "Meeting";
  const dateStr = parsed.date
    ? new Date(parsed.date).toLocaleDateString("it-IT")
    : new Date().toLocaleDateString("it-IT");
  const dateISO = parsed.date ?? new Date().toISOString().split("T")[0];
  const attendeeNames = (parsed.attendees ?? []).join(", ");
  const actionItems = parsed.actionItems ?? [];
  const { summary, keyDecisions = [], openQuestions = [] } = parsed;

  // Resolve email recipients: explicit sendTo takes priority, otherwise auto-lookup parsed attendees
  const emailTargets: string[] = [];
  if (sendTo) {
    const emailTarget = sendTo.includes("@") ? sendTo : null;
    if (emailTarget) {
      emailTargets.push(emailTarget);
    } else {
      const [emp] = await db.select({ email: employees.email })
        .from(employees)
        .where(sql`${employees.name} ILIKE ${"%" + sendTo + "%"}`)
        .limit(1);
      if (emp?.email) emailTargets.push(emp.email);
    }
  } else if (parsed.attendees?.length) {
    // Auto-lookup attendee emails from employees table
    for (const name of parsed.attendees) {
      const firstName = name.split(" ")[0];
      if (firstName.length < 2) continue;
      const [emp] = await db.select({ email: employees.email })
        .from(employees)
        .where(sql`${employees.name} ILIKE ${"%" + firstName + "%"}`)
        .limit(1);
      if (emp?.email && !emailTargets.includes(emp.email)) emailTargets.push(emp.email);
    }
  }

  if (emailTargets.length > 0) {
    await sendMeetingEmail(emailTargets, title, dateStr, parsed).catch(() => {});
  }

  // Create Notion action items with priority
  let notionCount = 0;
  if (config.NOTION_MEETING_ACTIONS_DATABASE_ID) {
    for (const item of actionItems) {
      await createNotionMeetingAction(item.title, {
        meetingTitle: title,
        meetingDate: dateISO,
        assignee: item.assignee ?? undefined,
        dueDate: item.dueDate ?? undefined,
        notes: item.context ? `${item.context}\n\nMeeting del ${dateStr} — ${summary}` : `Meeting del ${dateStr} — ${summary}`,
      }).catch(() => {});
      notionCount++;
    }
  }

  // Persist meeting to DB for rebuildBrainFromDB recovery
  await db.insert(intelligenceEvents).values({
    type: "meeting_notes",
    content: `${title}: ${summary.slice(0, 200)}`,
    status: "active",
    metadata: {
      driveFileId: resolvedDocId,
      autoDiscovered: !!autoFoundMessageId,
      title, date: dateISO,
      attendees: parsed.attendees ?? [],
      keyDecisions,
      actionItems,
      openQuestions,
    },
  }).catch(() => {});

  // Mark email as read if auto-found
  if (autoFoundMessageId) {
    await markEmailAsRead(autoFoundMessageId, auth).catch(() => {});
  }

  // Slack notification
  const notifCh = getNotificationsChannel();
  if (notifCh) {
    const priorityEmoji: Record<string, string> = { high: "🔴", medium: "🟡", low: "🟢" };
    const actionsList = actionItems.length
      ? actionItems.map((a) => `${priorityEmoji[a.priority ?? "medium"] ?? "•"} ${a.title}${a.assignee ? ` (${a.assignee})` : ""}`).join("\n")
      : "_Nessun action item_";
    const decisionsList = keyDecisions.length ? `\n\n*Decisioni:*\n${keyDecisions.map((d) => `• ${d}`).join("\n")}` : "";
    await sendSlackMessage(
      notifCh,
      `📋 *${title}* — ${dateStr}\n_${attendeeNames}_\n\n*Riassunto:* ${summary}${decisionsList}\n\n*Action items (${notionCount} su Notion):*\n${actionsList}`,
    ).catch(() => {});
  }

  // Feed brain (async — don't block the response)
  feedMeetingToBrain(
    title, dateISO,
    parsed.attendees ?? [],
    summary, keyDecisions, actionItems, openQuestions,
  ).catch(() => {});
  extractAndSaveFacts(docContent, title, dateISO).catch(() => {});

  logger.info({ docId: resolvedDocId, title, actions: actionItems.length, decisions: keyDecisions.length }, "Meeting doc processed");

  const priorityEmoji: Record<string, string> = { high: "🔴", medium: "🟡", low: "🟢" };
  const lines = [
    `✅ *${title}* — ${dateStr}`,
    `👥 ${attendeeNames || "partecipanti non rilevati"}`,
    ``,
    `*Riassunto:* ${summary}`,
    ...(keyDecisions.length ? [``, `*Decisioni prese:*`, ...keyDecisions.map((d) => `• ${d}`)] : []),
    ``,
    `*Action items su Notion (${notionCount}):*`,
    ...actionItems.map((a) => `${priorityEmoji[a.priority ?? "medium"] ?? "•"} ${a.title}${a.assignee ? ` → ${a.assignee}` : ""}${a.dueDate ? ` (${a.dueDate})` : ""}`),
    ...(actionItems.length === 0 ? ["_Nessun action item trovato._"] : []),
    ...(openQuestions.length ? [``, `*Domande aperte:*`, ...openQuestions.map((q) => `❓ ${q}`)] : []),
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
    const res = await (calendar.events.list as Function)({
      calendarId: "primary",
      timeMin: twoHoursAgo.toISOString(),
      timeMax: now.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      timeZone: config.TIMEZONE,
      conferenceDataVersion: 1,
    });

    const events = (res.data.items ?? []) as any[];

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

      // Parse notes with Claude
      const parsed = await parseNotesWithAI(docContent, title, attendeeNames);
      if (!parsed) {
        logger.warn({ meeting: title }, "Failed to parse meeting notes — skipping email/Notion");
        continue;
      }

      // Mark as processed with full metadata (for rebuildBrainFromDB recovery)
      await markAsProcessed(event.id, docId, title, {
        date: dateISO,
        attendees: attendees.map((a: any) => a.displayName ?? a.email ?? "?"),
        keyDecisions: parsed.keyDecisions ?? [],
        actionItems: parsed.actionItems ?? [],
        openQuestions: parsed.openQuestions ?? [],
        summary: parsed.summary,
      });

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

      // Feed brain (async — don't block)
      feedMeetingToBrain(
        title, dateISO,
        attendees.map((a: any) => a.displayName ?? a.email ?? "?"),
        parsed.summary, parsed.keyDecisions ?? [],
        parsed.actionItems ?? [], parsed.openQuestions ?? [],
      ).catch(() => {});
      extractAndSaveFacts(docContent ?? "", title, dateISO).catch(() => {});

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
