/**
 * Bot action audit log.
 *
 * Every autonomous action taken by the bot (task creation, auto-assignment,
 * escalation, email draft sent, etc.) is recorded here.
 * Accessible via /coo-audit in Slack.
 *
 * Uses the existing intelligence_events table (type = "bot_action") to avoid
 * adding a new table.
 */
import { eq, desc } from "drizzle-orm";
import { db } from "../models/database.js";
import { intelligenceEvents } from "../models/schema.js";
import { logger } from "../utils/logger.js";

export type BotActionType =
  | "task_created"
  | "task_auto_assigned"
  | "task_escalated"
  | "task_auto_prioritized"
  | "task_auto_scheduled"
  | "email_draft_sent"
  | "email_sent"
  | "notion_task_created"
  | "meeting_actions_approved"
  | "meeting_actions_skipped"
  | "draft_sent"
  | "draft_skipped"
  | "commitment_alert";

export async function logBotAction(
  type: BotActionType,
  description: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(intelligenceEvents).values({
      type: "bot_action",
      content: `[${type}] ${description.slice(0, 300)}`,
      status: "active",
      metadata: { actionType: type, ...metadata },
    });
  } catch (err) {
    // Non-critical — never let logging failures crash the caller
    logger.warn({ err, type }, "Failed to log bot action");
  }
}

export interface BotActionEntry {
  id: string;
  actionType: BotActionType;
  description: string;
  detectedAt: Date | null;
}

export async function getRecentBotActions(limit = 20): Promise<BotActionEntry[]> {
  try {
    const rows = await db
      .select({
        id: intelligenceEvents.id,
        content: intelligenceEvents.content,
        metadata: intelligenceEvents.metadata,
        detectedAt: intelligenceEvents.detectedAt,
      })
      .from(intelligenceEvents)
      .where(eq(intelligenceEvents.type, "bot_action"))
      .orderBy(desc(intelligenceEvents.detectedAt))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      actionType: ((r.metadata as any)?.actionType ?? "task_created") as BotActionType,
      description: r.content.replace(/^\[[^\]]+\] /, ""),
      detectedAt: r.detectedAt ? new Date(r.detectedAt) : null,
    }));
  } catch (err) {
    logger.warn({ err }, "getRecentBotActions failed");
    return [];
  }
}
