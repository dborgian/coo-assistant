/**
 * Draft response generator for urgent emails.
 *
 * When an urgent email arrives (high/critical + needs_reply), this service:
 *   1. Generates a professional reply draft using Haiku (no circular dep with agent.ts)
 *   2. Stores the draft in intelligence_events (type "draft_response")
 *   3. Sends a Block Kit Slack message to the owner with "Invia" / "Ignora" buttons
 *
 * The approval handlers live in src/bot/draft-approvals.ts.
 */
import Anthropic from "@anthropic-ai/sdk";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../models/database.js";
import { intelligenceEvents } from "../models/schema.js";
import { sendSlackBlocks, getNotificationsChannel } from "../bot/slack-monitor.js";
import { getRedis } from "../utils/conversation-cache.js";
import { logBotAction } from "./bot-actions.js";
import { logger } from "../utils/logger.js";

const DRAFT_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const drafter = new Anthropic();

interface DraftContext {
  emailId: string;        // Gmail message ID (for dedup + reply threading)
  from: string;
  subject: string;
  snippet: string;
  urgency: string;
}

/** Generates a professional reply draft using Haiku (avoids agent.ts circular dep). */
async function generateDraft(ctx: DraftContext): Promise<string> {
  try {
    const res = await drafter.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system:
        "Sei un COO professionale. Genera una breve risposta email in italiano — cordiale, professionale, diretta. " +
        "Rispondi SOLO con il corpo della risposta. Non includere oggetto, saluti iniziali (es. 'Caro'), né firma. " +
        "Se non hai abbastanza contesto per una risposta specifica, scrivi una risposta di presa in carico.",
      messages: [
        {
          role: "user",
          content: `Da: ${ctx.from}\nOggetto: ${ctx.subject}\n\n${ctx.snippet}\n\nGenera una risposta appropriata.`,
        },
      ],
    });
    const block = res.content.find((b) => b.type === "text");
    return block && block.type === "text" ? block.text.trim() : "";
  } catch (err) {
    logger.warn({ err }, "Haiku draft generation failed");
    return "";
  }
}

/**
 * Main entry point called from email-manager.ts when a critical/high+needs_reply
 * email is detected.
 */
export async function offerDraftResponse(ctx: DraftContext): Promise<void> {
  const redis = getRedis();
  const dedupKey = `draft:${ctx.emailId}`;

  // Dedup: don't generate a second draft for the same email
  try {
    if (redis) {
      const exists = await redis.exists(dedupKey);
      if (exists) return;
    } else {
      // Without Redis, check DB
      const [existing] = await db
        .select({ id: intelligenceEvents.id })
        .from(intelligenceEvents)
        .where(
          and(
            eq(intelligenceEvents.type, "draft_response"),
            sql`${intelligenceEvents.metadata}->>'emailId' = ${ctx.emailId}`,
          ),
        )
        .limit(1);
      if (existing) return;
    }
  } catch { /* allow through on error */ }

  const draft = await generateDraft(ctx);
  if (!draft || draft.length < 10) return;

  // Persist to DB so the approval handler can retrieve and send it
  let pendingId: string | null = null;
  try {
    const [row] = await db
      .insert(intelligenceEvents)
      .values({
        type: "draft_response",
        content: `Bozza risposta a ${ctx.from}: ${draft.slice(0, 150)}`,
        status: "pending_review",
        metadata: {
          emailId: ctx.emailId,
          from: ctx.from,
          subject: ctx.subject,
          replySubject: ctx.subject.startsWith("Re:") ? ctx.subject : `Re: ${ctx.subject}`,
          draft,
          urgency: ctx.urgency,
        },
      })
      .returning({ id: intelligenceEvents.id });
    pendingId = row?.id ?? null;
  } catch (err) {
    logger.error({ err }, "Failed to save draft_response to DB");
    return;
  }

  if (!pendingId) return;

  // Mark dedup key in Redis
  if (redis) {
    await redis.set(dedupKey, "1", "EX", DRAFT_TTL_SECONDS).catch(() => {});
  }

  // Send Block Kit approval message
  const notifCh = getNotificationsChannel();
  if (!notifCh) return;

  const urgencyEmoji = ctx.urgency === "critical" ? "🔴" : "🟠";
  const draftPreview = draft.length > 300 ? draft.slice(0, 297) + "..." : draft;

  await sendSlackBlocks(notifCh, `${urgencyEmoji} Bozza risposta email — ${ctx.from}`, [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${urgencyEmoji} *Email ${ctx.urgency.toUpperCase()} — bozza risposta*\n*Da:* ${ctx.from}\n*Oggetto:* ${ctx.subject}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Bozza:*\n> ${draftPreview.replace(/\n/g, "\n> ")}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: `draft_send_${pendingId}`,
          text: { type: "plain_text", text: "✉️ Invia risposta" },
          style: "primary",
        },
        {
          type: "button",
          action_id: `draft_skip_${pendingId}`,
          text: { type: "plain_text", text: "❌ Ignora" },
        },
      ],
    },
  ]).catch((err) => logger.warn({ err }, "Failed to send draft Block Kit message"));

  await logBotAction("email_draft_sent", `Bozza generata per email da ${ctx.from}: "${ctx.subject}"`, { emailId: ctx.emailId, pendingId });
  logger.info({ emailId: ctx.emailId, pendingId }, "Draft response offered to owner");
}
