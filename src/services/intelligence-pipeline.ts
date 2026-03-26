import { eq, sql } from "drizzle-orm";
import { db } from "../models/database.js";
import { employees, intelligenceEvents, messageLogs } from "../models/schema.js";
import { logger } from "../utils/logger.js";

// Commitment patterns (Italian + English)
const COMMITMENT_PATTERNS = [
  /\b(lo faccio io|ci penso io|me ne occupo|ci parlo io|lo preparo|glielo mando|te lo mando)\b/i,
  /\b(faro|faro'|preparero|inviero|mandero|consegnero|finiro)\b/i,
  /\b(I'll do|I will|I'll take care|I'll handle|I'll send|I'll prepare|I got this|on it|leave it to me|count on me)\b/i,
];

// Decision patterns
const DECISION_PATTERNS = [
  /\b(abbiamo deciso|facciamo cosi|ok approvato|confermato|si fa|andiamo con|scegliamo|la decisione e'|abbiamo concordato|d'accordo su|procediamo con|via libera)\b/i,
  /\b(we decided|let's go with|approved|decided|confirmed|agreed on|green light|final decision)\b/i,
];

function matchesPatterns(content: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(content));
}

async function findEmployeeByName(senderName: string): Promise<string | null> {
  if (!senderName || senderName === "Unknown") return null;
  const [emp] = await db
    .select({ id: employees.id })
    .from(employees)
    .where(sql`${employees.name} ILIKE ${"%" + senderName + "%"}`)
    .limit(1);
  return emp?.id ?? null;
}

/**
 * Run inline extractors on every incoming message.
 * Uses regex only — zero AI cost, <1ms per call.
 * Called from slack-monitor.ts and monitors.ts after db.insert(messageLogs).
 */
export async function runInlineExtractors(
  messageLogId: string,
  content: string,
  senderName: string,
  channel: string,
): Promise<void> {
  try {
    const employeeId = await findEmployeeByName(senderName);

    // Check for commitments
    if (matchesPatterns(content, COMMITMENT_PATTERNS)) {
      await db.insert(intelligenceEvents).values({
        type: "commitment",
        employeeId,
        messageLogId,
        channel,
        content: content.slice(0, 500),
        status: "open",
      });
      logger.debug({ sender: senderName, channel }, "Commitment detected");
    }

    // Check for decisions
    if (matchesPatterns(content, DECISION_PATTERNS)) {
      await db.insert(intelligenceEvents).values({
        type: "decision",
        employeeId,
        messageLogId,
        channel,
        content: content.slice(0, 500),
        status: "active",
      });
      logger.debug({ sender: senderName, channel }, "Decision detected");
    }
  } catch (err) {
    logger.error({ err }, "Intelligence pipeline extraction failed");
  }
}
