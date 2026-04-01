/**
 * Slack action handlers for meeting note approval flow.
 *
 * When the automated meeting-notes check detects a new Google Meet, it sends a
 * Block Kit message with "Crea su Notion" / "Salta" buttons instead of creating
 * Notion tasks automatically. These handlers process the user's choice.
 */
import { and, eq, sql } from "drizzle-orm";
import type { App as SlackApp } from "@slack/bolt";
import { db } from "../models/database.js";
import { intelligenceEvents } from "../models/schema.js";
import { createNotionMeetingAction } from "../services/notion-sync.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

interface PendingActionItem {
  title: string;
  assignee?: string;
  dueDate?: string;
  priority?: string;
  context?: string;
}

interface MeetingPendingMeta {
  calendarEventId: string;
  title: string;
  date: string;
  actionItems: PendingActionItem[];
}

export function registerMeetingApprovals(app: SlackApp): void {
  // "Crea su Notion" button
  app.action(/^meet_approve_/, async ({ body, ack, respond }) => {
    await ack();
    const actionId = ((body as any).actions?.[0]?.action_id ?? "") as string;
    const calendarEventId = actionId.replace("meet_approve_", "");

    try {
      const [pending] = await db
        .select()
        .from(intelligenceEvents)
        .where(
          and(
            eq(intelligenceEvents.type, "meeting_pending"),
            eq(intelligenceEvents.status, "pending_review"),
            sql`${intelligenceEvents.metadata}->>'calendarEventId' = ${calendarEventId}`,
          ),
        )
        .limit(1);

      if (!pending) {
        await respond({ text: "Dati meeting non trovati o gia' processati.", replace_original: true });
        return;
      }

      const meta = pending.metadata as unknown as MeetingPendingMeta;
      const actionItems = meta.actionItems ?? [];
      let created = 0;

      if (config.NOTION_MEETING_ACTIONS_DATABASE_ID && actionItems.length) {
        for (const item of actionItems) {
          await createNotionMeetingAction(item.title, {
            meetingTitle: meta.title,
            meetingDate: meta.date,
            assignee: item.assignee ?? undefined,
            dueDate: item.dueDate ?? undefined,
            notes: item.context
              ? `${item.context}\n\nMeeting del ${meta.date}`
              : `Meeting del ${meta.date}`,
          }).catch((err) => logger.warn({ err, item: item.title }, "Failed to create Notion meeting action"));
          created++;
        }
      }

      // Update status so it won't show up as pending again
      await db
        .update(intelligenceEvents)
        .set({ status: "active" })
        .where(eq(intelligenceEvents.id, pending.id));

      const resultText = created > 0
        ? `✅ ${created} action item${created > 1 ? "s" : ""} creati su Notion.`
        : "✅ Approvato — nessun action item da creare.";

      await respond({ text: resultText, replace_original: true });
      logger.info({ calendarEventId, created }, "Meeting action items approved and created");
    } catch (err) {
      logger.error({ err, calendarEventId }, "Failed to process meeting approval");
      await respond({ text: "Errore durante la creazione dei task su Notion.", replace_original: true });
    }
  });

  // "Salta" button
  app.action(/^meet_skip_/, async ({ body, ack, respond }) => {
    await ack();
    const actionId = ((body as any).actions?.[0]?.action_id ?? "") as string;
    const calendarEventId = actionId.replace("meet_skip_", "");

    try {
      await db
        .update(intelligenceEvents)
        .set({ status: "skipped" })
        .where(
          and(
            eq(intelligenceEvents.type, "meeting_pending"),
            sql`${intelligenceEvents.metadata}->>'calendarEventId' = ${calendarEventId}`,
          ),
        );

      await respond({ text: "⏭️ Action items saltati — nessun task creato.", replace_original: true });
      logger.info({ calendarEventId }, "Meeting action items skipped");
    } catch (err) {
      logger.error({ err, calendarEventId }, "Failed to skip meeting actions");
      await respond({ text: "Errore durante lo skip.", replace_original: true });
    }
  });
}
