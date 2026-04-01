/**
 * Slack action handlers for draft email response approval.
 *
 * "Invia risposta" → retrieves draft from DB, sends email, marks as sent.
 * "Ignora"         → marks as skipped.
 */
import { eq, sql } from "drizzle-orm";
import type { App as SlackApp } from "@slack/bolt";
import { db } from "../models/database.js";
import { intelligenceEvents } from "../models/schema.js";
import { sendEmail } from "../services/email-manager.js";
import { logBotAction } from "../services/bot-actions.js";
import { logger } from "../utils/logger.js";

interface DraftMeta {
  emailId: string;
  from: string;
  subject: string;
  replySubject: string;
  draft: string;
  urgency: string;
}

export function registerDraftApprovals(app: SlackApp): void {
  // "Invia risposta" button
  app.action(/^draft_send_/, async ({ body, ack, respond }) => {
    await ack();
    const actionId = ((body as any).actions?.[0]?.action_id ?? "") as string;
    const pendingId = actionId.replace("draft_send_", "");

    try {
      const [pending] = await db
        .select()
        .from(intelligenceEvents)
        .where(eq(intelligenceEvents.id, pendingId))
        .limit(1);

      if (!pending || pending.status !== "pending_review") {
        await respond({ text: "Bozza non trovata o gia' processata.", replace_original: true });
        return;
      }

      const meta = pending.metadata as unknown as DraftMeta;

      // Extract email address from "Name <email@domain>" or plain address
      const emailMatch = meta.from.match(/<([^>]+)>/) ?? [null, meta.from];
      const replyTo = emailMatch[1] ?? meta.from;

      const sent = await sendEmail(replyTo, meta.replySubject, meta.draft);

      if (!sent) {
        await respond({ text: "Errore nell'invio della risposta. Controlla la configurazione Gmail.", replace_original: true });
        return;
      }

      await db
        .update(intelligenceEvents)
        .set({ status: "fulfilled" })
        .where(eq(intelligenceEvents.id, pendingId));

      await logBotAction("draft_sent", `Risposta inviata a ${replyTo} — "${meta.replySubject}"`, { pendingId, to: replyTo });
      await respond({ text: `✅ Risposta inviata a ${replyTo}.`, replace_original: true });
      logger.info({ pendingId, to: replyTo }, "Draft response sent");
    } catch (err) {
      logger.error({ err, pendingId }, "Failed to send draft response");
      await respond({ text: "Errore durante l'invio.", replace_original: true });
    }
  });

  // "Ignora" button
  app.action(/^draft_skip_/, async ({ body, ack, respond }) => {
    await ack();
    const actionId = ((body as any).actions?.[0]?.action_id ?? "") as string;
    const pendingId = actionId.replace("draft_skip_", "");

    try {
      await db
        .update(intelligenceEvents)
        .set({ status: "skipped" })
        .where(eq(intelligenceEvents.id, pendingId));

      await logBotAction("draft_skipped", `Bozza ignorata — ID ${pendingId}`, { pendingId });
      await respond({ text: "⏭️ Bozza ignorata.", replace_original: true });
    } catch (err) {
      logger.error({ err, pendingId }, "Failed to skip draft");
      await respond({ text: "Errore.", replace_original: true });
    }
  });
}
