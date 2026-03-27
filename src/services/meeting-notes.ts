import { google } from "googleapis";
import { agent } from "../core/agent.js";
import { config } from "../config.js";
import { getGoogleAuth, isGoogleConfigured } from "../core/google-auth.js";
import { sendSlackMessage } from "../bot/slack-monitor.js";
import { createMeetingDoc } from "./google-docs-manager.js";
import { logger } from "../utils/logger.js";

/** Track meetings we've already processed */
const processedMeetings = new Set<string>();

/**
 * Check for meetings that ended recently and generate notes.
 * Scheduled every 30 minutes.
 */
export async function checkRecentMeetings(): Promise<void> {
  if (!isGoogleConfigured()) return;

  const auth = getGoogleAuth();
  if (!auth) return;

  const calendar = google.calendar({ version: "v3", auth });
  const now = new Date();
  const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000);

  try {
    const res = await calendar.events.list({
      calendarId: "primary",
      timeMin: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours back
      timeMax: now.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      timeZone: config.TIMEZONE,
    });

    const events = res.data.items ?? [];

    for (const event of events) {
      if (!event.id || processedMeetings.has(event.id)) continue;

      const endTime = event.end?.dateTime ? new Date(event.end.dateTime) : null;
      if (!endTime || endTime > now || endTime < thirtyMinAgo) continue;

      // Meeting ended in last 30 min
      const title = event.summary ?? "Meeting";
      const attendees = (event.attendees ?? []).map((a) => a.displayName ?? a.email ?? "?").join(", ");
      const date = endTime.toLocaleDateString("it-IT");

      processedMeetings.add(event.id);

      // Try to find a transcript in Google Drive
      const drive = google.drive({ version: "v3", auth });
      let transcript: string | null = null;

      try {
        const driveRes = await drive.files.list({
          q: `name contains '${title.replace(/'/g, "\\'")}' and mimeType = 'text/plain' and modifiedTime > '${thirtyMinAgo.toISOString()}'`,
          fields: "files(id, name)",
          pageSize: 1,
        });

        const transcriptFile = driveRes.data.files?.[0];
        if (transcriptFile?.id) {
          const content = await drive.files.get(
            { fileId: transcriptFile.id, alt: "media" },
            { responseType: "text" },
          );
          transcript = typeof content.data === "string" ? content.data : String(content.data);
        }
      } catch {
        // No transcript found — that's ok
      }

      // Generate meeting notes
      const context = transcript
        ? { meeting: title, date, attendees, transcript: transcript.slice(0, 5000) }
        : { meeting: title, date, attendees };

      const prompt = transcript
        ? `Analizza il transcript di questo meeting e genera: 1) Summary (max 200 char), 2) Decisioni prese (lista), 3) Action items con responsabile (lista). In italiano.`
        : `Il meeting "${title}" con ${attendees} e' appena finito. Non ho il transcript. Genera un template per le note con sezioni: Summary, Decisioni, Action Items. Chiedi di compilarlo.`;

      const notes = await agent.think(prompt, context);

      if (!notes || notes.trim().length < 20) continue;

      // Create Google Doc with meeting notes
      const doc = await createMeetingDoc(
        title,
        date,
        notes,
        [], // AI already structured the notes in the text
        [],
      );

      // Post to Slack
      if (config.SLACK_NOTIFICATIONS_CHANNEL) {
        const docLink = doc ? `\nGoogle Doc: ${doc.url}` : "";
        await sendSlackMessage(
          config.SLACK_NOTIFICATIONS_CHANNEL,
          `Meeting Notes — *${title}* (${date})\nPartecipanti: ${attendees}\n\n${notes}${docLink}`,
        ).catch(() => {});
      }

      logger.info({ meeting: title, hasTranscript: !!transcript, docCreated: !!doc }, "Meeting notes generated");
    }
  } catch (err) {
    logger.error({ err }, "Failed to check recent meetings");
  }

  // Cleanup old processed meetings
  if (processedMeetings.size > 200) {
    const entries = [...processedMeetings];
    entries.slice(0, entries.length - 200).forEach((id) => processedMeetings.delete(id));
  }
}
