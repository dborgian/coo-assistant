import type { Bot } from "grammy";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../models/database.js";
import { employees, intelligenceEvents, tasks } from "../models/schema.js";
import { logger } from "../utils/logger.js";

export async function checkCommitmentFulfillment(bot: Bot): Promise<void> {
  const twoDaysAgo = new Date();
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

  // Get open commitments older than 48h
  const openCommitments = await db
    .select()
    .from(intelligenceEvents)
    .where(
      and(
        eq(intelligenceEvents.type, "commitment"),
        eq(intelligenceEvents.status, "open"),
        lte(intelligenceEvents.detectedAt, twoDaysAgo),
      ),
    );

  if (!openCommitments.length) return;

  const unfulfilled: string[] = [];

  for (const commitment of openCommitments) {
    let empName = "Qualcuno";
    if (commitment.employeeId) {
      const [emp] = await db
        .select({ name: employees.name })
        .from(employees)
        .where(eq(employees.id, commitment.employeeId))
        .limit(1);
      if (emp) empName = emp.name;
    }

    const daysAgo = Math.floor(
      (Date.now() - new Date(commitment.detectedAt!).getTime()) / (1000 * 60 * 60 * 24),
    );

    unfulfilled.push(`- ${empName}: "${commitment.content.slice(0, 100)}" (${daysAgo} giorni fa in ${commitment.channel ?? "?"})`);
  }

  if (unfulfilled.length) {
    try {
      await bot.api.sendMessage(
        config.TELEGRAM_OWNER_CHAT_ID,
        `\uD83D\uDD0D Promesse non mantenute (${unfulfilled.length}):\n${unfulfilled.join("\n")}`,
      );
    } catch (err) {
      logger.error({ err }, "Failed to send commitment alert");
    }
  }
}

export async function getCommitments(
  status: string = "open",
  employeeName?: string,
  days: number = 7,
): Promise<string> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  let query = db
    .select()
    .from(intelligenceEvents)
    .where(
      and(
        eq(intelligenceEvents.type, "commitment"),
        status !== "all" ? eq(intelligenceEvents.status, status) : undefined,
        gte(intelligenceEvents.detectedAt, cutoff),
      ),
    );

  const commitments = await query;
  if (!commitments.length) return `Nessun commitment ${status} negli ultimi ${days} giorni.`;

  const lines: string[] = [];
  for (const c of commitments) {
    let empName = "?";
    if (c.employeeId) {
      const [emp] = await db
        .select({ name: employees.name })
        .from(employees)
        .where(eq(employees.id, c.employeeId))
        .limit(1);
      if (emp) empName = emp.name;
    }

    if (employeeName && !empName.toLowerCase().includes(employeeName.toLowerCase())) continue;

    const icon = c.status === "fulfilled" ? "\u2705" : c.status === "broken" ? "\u274C" : "\u23F3";
    lines.push(`${icon} ${empName}: "${c.content.slice(0, 100)}" — ${c.channel ?? "?"} (${new Date(c.detectedAt!).toLocaleDateString("it-IT")})`);
  }

  return lines.length ? lines.join("\n") : "Nessun risultato con i filtri specificati.";
}
