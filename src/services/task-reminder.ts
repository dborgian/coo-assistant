import type { Bot } from "grammy";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../models/database.js";
import { employees, tasks } from "../models/schema.js";
import { sendEmail } from "./email-manager.js";
import { sendSlackTaskNotification } from "../bot/slack-monitor.js";
import { notifyAssigneeAndOwner } from "../utils/telegram.js";
import { logger } from "../utils/logger.js";

// Checkpoint levels: 1=24h (email), 2=6h (slack), 3=1h (email+slack)
function getTargetLevel(hoursLeft: number): number {
  if (hoursLeft <= 1) return 3;
  if (hoursLeft <= 6) return 2;
  if (hoursLeft <= 24) return 1;
  return 0; // >24h: no reminder yet
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
    let emp: { name: string; email: string | null; googleEmail: string | null; slackMemberId: string | null } | null = null;
    if (task.assignedTo) {
      const [row] = await db
        .select({ name: employees.name, email: employees.email, googleEmail: employees.googleEmail, slackMemberId: employees.slackMemberId })
        .from(employees)
        .where(eq(employees.id, task.assignedTo))
        .limit(1);
      emp = row ?? null;
    }

    const assigneeName = emp?.name ?? "non assegnato";
    const assigneeEmail = emp?.email ?? emp?.googleEmail ?? null;
    const assigneeSlackId = emp?.slackMemberId ?? null;

    const dueStr = new Date(task.dueDate!).toLocaleString("it-IT", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    const hoursLabel = hoursLeft <= 1 ? "1 ora" : hoursLeft <= 6 ? "6 ore" : "24 ore";

    const emailSubject = `Reminder task: "${task.title}" — scade tra ${hoursLabel}`;
    const emailBody = `Ciao ${assigneeName},\n\nIl task "${task.title}" scade il ${dueStr} (tra ${hoursLabel}).\n\nPriorità: ${task.priority}\n${task.description ? `\nDescrizione: ${task.description}\n` : ""}\nAggiorna lo stato o completalo il prima possibile.\n\nGrazie,\nCOO Assistant`;
    const slackMsg = `⏰ Reminder: il task *"${task.title}"* scade tra *${hoursLabel}* (${dueStr}). Aggiorna lo stato.`;
    const telegramMsg = `<b>⏰ Reminder task</b> — scade tra ${hoursLabel}\n\n<b>${task.title}</b>\nAssegnato a: ${assigneeName}\nScadenza: ${dueStr}\nPriorità: ${task.priority}`;

    try {
      if (targetLevel === 1) {
        // 24h: Email only
        if (assigneeEmail) {
          await sendEmail(assigneeEmail, emailSubject, emailBody);
        }
      } else if (targetLevel === 2) {
        // 6h: Slack only
        if (assigneeSlackId) {
          await sendSlackTaskNotification(assigneeSlackId, slackMsg, task.id);
        }
      } else if (targetLevel === 3) {
        // 1h: Email + Slack
        if (assigneeEmail) {
          await sendEmail(assigneeEmail, emailSubject, emailBody);
        }
        if (assigneeSlackId) {
          await sendSlackTaskNotification(assigneeSlackId, slackMsg, task.id);
        }
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
