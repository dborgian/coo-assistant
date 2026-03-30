import type { Bot } from "grammy";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../models/database.js";
import { employees, tasks } from "../models/schema.js";
import { sendEmail } from "./email-manager.js";
import { sendSlackTaskNotification } from "../bot/slack-monitor.js";
import { notifyAssigneeAndOwner } from "../utils/telegram.js";
import { logger } from "../utils/logger.js";

// Checkpoint levels: 1=24h (email), 2=6h (slack), 3=1h (email+slack)
export function getTargetLevel(hoursLeft: number): number {
  if (hoursLeft <= 1) return 3;
  if (hoursLeft <= 6) return 2;
  if (hoursLeft <= 24) return 1;
  return 0; // >24h: email only (assignment notification case)
}

/**
 * Send a tiered notification to a task assignee based on hours left to deadline.
 * > 24h  → Email only
 * 6–24h  → Email only
 * 1–6h   → Slack only
 * ≤ 1h   → Email + Slack
 */
export async function sendTieredNotification(
  task: { id?: string; title: string; priority: string | null; description: string | null; dueDate: Date },
  assignee: { name: string; email: string | null; googleEmail?: string | null; slackMemberId: string | null; timezone?: string | null },
  label = "Reminder",
): Promise<void> {
  const hoursLeft = (task.dueDate.getTime() - Date.now()) / 3_600_000;
  if (hoursLeft < 0) return; // overdue — handled by escalation

  const assigneeEmail = assignee.email ?? assignee.googleEmail ?? null;
  const tz = assignee.timezone ?? config.TIMEZONE ?? "Europe/Rome";
  const dueStr = task.dueDate.toLocaleString("it-IT", { timeZone: tz, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

  let hoursLabel: string;
  if (hoursLeft <= 1) hoursLabel = "meno di 1 ora";
  else if (hoursLeft <= 6) hoursLabel = `${Math.round(hoursLeft)} ore`;
  else if (hoursLeft <= 24) hoursLabel = "24 ore";
  else hoursLabel = `${Math.round(hoursLeft / 24)} giorni`;

  const emailSubject = `${label}: "${task.title}" — scade tra ${hoursLabel}`;
  const emailBody =
    `Ciao ${assignee.name},\n\n` +
    `Il task "${task.title}" scade il ${dueStr} (tra ${hoursLabel}).\n\n` +
    `Priorità: ${task.priority ?? "medium"}\n` +
    (task.description ? `\nDescrizione: ${task.description}\n` : "") +
    `\nAggiorna lo stato o completalo il prima possibile.\n\nGrazie,\nCOO Assistant`;
  const slackMsg = `⏰ ${label}: il task *"${task.title}"* scade tra *${hoursLabel}* (${dueStr}).`;

  // Tier logic: >24h and 6-24h → email; 1-6h → slack; ≤1h → both
  const sendEmailNotif = hoursLeft > 6 || hoursLeft <= 1;
  const sendSlack = hoursLeft <= 6;

  if (sendEmailNotif && assigneeEmail) {
    await sendEmail(assigneeEmail, emailSubject, emailBody);
  }
  if (sendSlack && assignee.slackMemberId && task.id) {
    await sendSlackTaskNotification(assignee.slackMemberId, slackMsg, task.id);
  }
}

export async function checkAndSendReminders(bot: Bot): Promise<void> {
  const now = new Date();

  const activeTasks = await db
    .select()
    .from(tasks)
    .where(
      and(
        isNotNull(tasks.dueDate),
        inArray(tasks.status, ["pending", "in_progress"]),
      ),
    );

  for (const task of activeTasks) {
    const hoursLeft = (new Date(task.dueDate!).getTime() - now.getTime()) / 3_600_000;

    // Skip overdue (handled by escalation) and tasks with >24h remaining
    if (hoursLeft < 0 || hoursLeft > 24) continue;

    const currentLevel = task.reminderLevel ?? 0;
    const targetLevel = getTargetLevel(hoursLeft);

    if (targetLevel <= currentLevel) continue; // already sent this checkpoint

    // Lookup assignee
    let emp: { name: string; email: string | null; googleEmail: string | null; slackMemberId: string | null; timezone: string | null } | null = null;
    if (task.assignedTo) {
      const [row] = await db
        .select({ name: employees.name, email: employees.email, googleEmail: employees.googleEmail, slackMemberId: employees.slackMemberId, timezone: employees.timezone })
        .from(employees)
        .where(eq(employees.id, task.assignedTo))
        .limit(1);
      emp = row ?? null;
    }

    const assigneeName = emp?.name ?? "non assegnato";
    const empTz = emp?.timezone ?? config.TIMEZONE ?? "Europe/Rome";
    const dueStr = new Date(task.dueDate!).toLocaleString("it-IT", { timeZone: empTz, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    const hoursLabel = hoursLeft <= 1 ? "1 ora" : hoursLeft <= 6 ? "6 ore" : "24 ore";
    const telegramMsg = `<b>⏰ Reminder task</b> — scade tra ${hoursLabel}\n\n<b>${task.title}</b>\nAssegnato a: ${assigneeName}\nScadenza: ${dueStr}\nPriorità: ${task.priority}`;

    try {
      if (emp) {
        await sendTieredNotification(
          { id: task.id, title: task.title, priority: task.priority, description: task.description, dueDate: new Date(task.dueDate!) },
          emp,
        );
      }

      // Always notify owner via Telegram
      await notifyAssigneeAndOwner(bot, task.assignedTo ?? null, telegramMsg, "HTML");

      await db.update(tasks)
        .set({ reminderLevel: targetLevel, updatedAt: now })
        .where(eq(tasks.id, task.id));

      logger.info({ task: task.title, assignee: assigneeName, level: targetLevel, hoursLeft: Math.round(hoursLeft) }, "Tiered reminder sent");
    } catch (err) {
      logger.error({ err, task: task.title, level: targetLevel }, "Failed to send tiered reminder");
    }
  }
}
