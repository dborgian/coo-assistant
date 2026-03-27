import type { Bot } from "grammy";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { agent } from "../core/agent.js";
import { config } from "../config.js";
import { db } from "../models/database.js";
import { employees, messageLogs, tasks } from "../models/schema.js";
import { sendSlackMessage } from "../bot/slack-monitor.js";
import { logger } from "../utils/logger.js";

/**
 * Send EOD prompts to all active employees via Slack DM.
 * Scheduled at 17:30.
 */
export async function sendEodPrompts(): Promise<void> {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const activeEmployees = await db
    .select()
    .from(employees)
    .where(eq(employees.isActive, true));

  let sent = 0;
  for (const emp of activeEmployees) {
    if (!emp.slackMemberId) continue;

    try {
      // Get employee's task activity today
      const empTasks = await db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.assignedTo, emp.id),
            inArray(tasks.status, ["pending", "in_progress", "done"]),
          ),
        );

      const completedToday = empTasks.filter(
        (t) => t.status === "done" && t.updatedAt && new Date(t.updatedAt) >= todayStart,
      );
      const inProgress = empTasks.filter((t) => t.status === "in_progress");
      const overdue = empTasks.filter(
        (t) => t.dueDate && new Date(t.dueDate) < now && t.status !== "done",
      );

      const taskSummary = [
        completedToday.length ? `Completati oggi: ${completedToday.map((t) => t.title).join(", ")}` : null,
        inProgress.length ? `In corso: ${inProgress.map((t) => t.title).join(", ")}` : null,
        overdue.length ? `Overdue: ${overdue.map((t) => t.title).join(", ")}` : null,
      ].filter(Boolean).join("\n");

      const message =
        `Ciao ${emp.name}! Come e' andata oggi?\n\n` +
        (taskSummary ? `Ecco i tuoi task:\n${taskSummary}\n\n` : "") +
        `Rispondimi con un breve aggiornamento: cosa hai fatto, blockers, e cosa prevedi per domani.`;

      await sendSlackMessage(emp.slackMemberId, message);
      sent++;
    } catch (err) {
      logger.error({ err, employee: emp.name }, "Failed to send EOD prompt");
    }
  }

  if (sent) {
    logger.info({ sent }, "EOD prompts sent");
  }
}

/**
 * Collect EOD responses and generate unified team report.
 * Scheduled at 18:30 (1 hour after prompts).
 */
export async function collectEodResponses(bot: Bot): Promise<void> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const activeEmployees = await db
    .select()
    .from(employees)
    .where(and(eq(employees.isActive, true), sql`${employees.slackMemberId} IS NOT NULL`));

  if (!activeEmployees.length) return;

  const responses: Array<{ name: string; response: string }> = [];

  for (const emp of activeEmployees) {
    // Find DM responses from this employee in the last hour
    const recentDMs = await db
      .select({ content: messageLogs.content, fullContent: messageLogs.fullContent })
      .from(messageLogs)
      .where(
        and(
          eq(messageLogs.source, "slack"),
          eq(messageLogs.senderId, emp.slackMemberId!),
          gte(messageLogs.receivedAt, oneHourAgo),
        ),
      )
      .orderBy(messageLogs.receivedAt);

    if (recentDMs.length) {
      const combined = recentDMs
        .map((m) => m.fullContent ?? m.content)
        .join(" ");
      responses.push({ name: emp.name, response: combined });
    }
  }

  if (!responses.length) {
    logger.debug("No EOD responses collected");
    return;
  }

  // Generate unified EOD report
  const report = await agent.think(
    `Genera un report EOD (End of Day) del team basato sulle risposte ricevute.
Struttura: per ogni persona, riassumi in 1-2 righe cosa hanno fatto e eventuali blockers.
Alla fine, aggiungi una sezione "Highlights" con i punti salienti della giornata.
Scrivi in italiano, max 800 caratteri. Sii conciso e diretto.`,
    {
      date: new Date().toISOString().split("T")[0],
      team_responses: responses,
      team_size: activeEmployees.length,
      responses_received: responses.length,
    },
  );

  if (!report || report.trim().length < 20) return;

  const msg = `EOD Report — ${new Date().toLocaleDateString("it-IT")}\n\n${report}\n\n(${responses.length}/${activeEmployees.length} risposte ricevute)`;

  // Post to Slack + Telegram
  try {
    if (config.SLACK_NOTIFICATIONS_CHANNEL) {
      await sendSlackMessage(config.SLACK_NOTIFICATIONS_CHANNEL, msg);
    }
    await bot.api.sendMessage(config.TELEGRAM_OWNER_CHAT_ID, msg);
    logger.info({ responses: responses.length }, "EOD report generated and sent");
  } catch (err) {
    logger.error({ err }, "Failed to send EOD report");
  }
}
