import { and, eq, inArray, isNotNull, or, lte, isNull, sql } from "drizzle-orm";
import { agent } from "../core/agent.js";
import { config } from "../config.js";
import { db } from "../models/database.js";
import { employees, tasks } from "../models/schema.js";
import { sendEmail } from "./email-manager.js";
import { sendSlackMessage, sendSlackTaskNotification, getNotificationsChannel } from "../bot/slack-monitor.js";
import { logger } from "../utils/logger.js";
import { notifyAssigneeAndOwner } from "../utils/notify.js";

interface EscalationAction {
  taskId: string;
  taskTitle: string;
  newLevel: number;
  assignedTo?: string;
  assigneeName?: string;
  assigneeEmail?: string;
  assigneeSlackId?: string;
}

function calculateEscalationLevel(dueDate: Date): number {
  const now = Date.now();
  const due = dueDate.getTime();
  const hoursUntilDue = (due - now) / (1000 * 60 * 60);
  const daysOverdue = (now - due) / (1000 * 60 * 60 * 24);

  if (daysOverdue >= 7) return 4;    // L4: Critical — 7+ days overdue
  if (daysOverdue >= 3) return 3;    // L3: Stale warning — 3+ days overdue
  if (daysOverdue > 0) return 2;     // L2: Overdue alert
  if (hoursUntilDue <= 24) return 1; // L1: Direct reminder — due within 24h
  if (hoursUntilDue <= 48) return 0; // L0: Soft reminder — due within 48h
  return -1; // No escalation needed
}

export async function runEscalationCheck(): Promise<void> {
  const now = new Date();

  const activeTasks = await db
    .select()
    .from(tasks)
    .where(
      and(
        inArray(tasks.status, ["pending", "in_progress"]),
        isNotNull(tasks.dueDate),
        or(
          isNull(tasks.escalationPausedUntil),
          lte(tasks.escalationPausedUntil, now),
        ),
      ),
    );

  if (!activeTasks.length) return;

  const actions: EscalationAction[] = [];

  for (const task of activeTasks) {
    // Skip blocked tasks
    if (task.blockedBy) {
      try {
        const deps: string[] = JSON.parse(task.blockedBy);
        if (deps.length > 0) continue;
      } catch { /* ignore parse errors */ }
    }

    const newLevel = calculateEscalationLevel(new Date(task.dueDate!));
    const currentLevel = task.escalationLevel ?? 0;

    if (newLevel <= currentLevel || newLevel < 0) continue;

    let assigneeName: string | undefined;
    let assigneeEmail: string | undefined;
    let assigneeSlackId: string | undefined;

    if (task.assignedTo) {
      const [emp] = await db
        .select()
        .from(employees)
        .where(eq(employees.id, task.assignedTo))
        .limit(1);
      if (emp) {
        assigneeName = emp.name;
        assigneeEmail = emp.email ?? emp.googleEmail ?? undefined;
        assigneeSlackId = emp.slackMemberId ?? undefined;
      }
    }

    actions.push({
      taskId: task.id,
      taskTitle: task.title,
      newLevel,
      assignedTo: task.assignedTo ?? undefined,
      assigneeName,
      assigneeEmail,
      assigneeSlackId,
    });

    // Update DB
    await db
      .update(tasks)
      .set({ escalationLevel: newLevel, lastEscalatedAt: now })
      .where(eq(tasks.id, task.id));
  }

  // Execute escalation actions
  for (const action of actions) {
    try {
      await executeEscalation(action);
    } catch (err) {
      logger.error({ err, task: action.taskTitle, level: action.newLevel }, "Escalation action failed");
    }
  }

  if (actions.length) {
    logger.info({ count: actions.length }, "Escalation check completed");
  }
}

async function executeEscalation(action: EscalationAction): Promise<void> {
  const { taskTitle, newLevel, assignedTo, assigneeName, assigneeEmail, assigneeSlackId } = action;
  const assignee = assigneeName ?? "non assegnato";

  switch (newLevel) {
    case 0: {
      // L0: Soft reminder
      await notifyAssigneeAndOwner(
        assignedTo ?? null,
        `\u23F0 Task "${taskTitle}" scade tra meno di 48 ore (${assignee})`,
      );
      break;
    }
    case 1: {
      // L1: Direct reminder — Email + Slack DM to assignee + Telegram
      if (assigneeEmail) {
        await sendEmail(
          assigneeEmail,
          `Reminder: "${taskTitle}" scade domani`,
          `Ciao ${assigneeName},\n\nIl task "${taskTitle}" scade domani. Per favore aggiorna lo stato o completa il task.\n\nGrazie,\nCOO Assistant`,
        );
      }
      if (assigneeSlackId) {
        await sendSlackTaskNotification(assigneeSlackId, `\u23F0 Reminder: il task "${taskTitle}" scade domani. Aggiorna lo stato per favore.`, action.taskId);
      }
      await notifyAssigneeAndOwner(
        assignedTo ?? null,
        `\u23F0 L1: Task "${taskTitle}" scade tra 24h — notificato ${assignee} via ${assigneeEmail ? "email" : ""}${assigneeEmail && assigneeSlackId ? " + " : ""}${assigneeSlackId ? "Slack" : ""}`,
      );
      break;
    }
    case 2: {
      // L2: Overdue alert — Telegram + Email
      await notifyAssigneeAndOwner(
        assignedTo ?? null,
        `\uD83D\uDD34 OVERDUE: Task "${taskTitle}" ha superato la scadenza! (${assignee})`,
      );
      if (assigneeEmail) {
        await sendEmail(
          assigneeEmail,
          `OVERDUE: "${taskTitle}"`,
          `Ciao ${assigneeName},\n\nIl task "${taskTitle}" e' scaduto. Per favore completalo il prima possibile o aggiorna lo stato.\n\nGrazie,\nCOO Assistant`,
        );
      }
      break;
    }
    case 3: {
      // L3: Stale warning — Telegram + Slack #general
      await notifyAssigneeAndOwner(
        assignedTo ?? null,
        `\u26A0\uFE0F Task "${taskTitle}" fermo da 3+ giorni dopo la scadenza (${assignee}). Serve intervento.`,
      );
      const _notifCh = getNotificationsChannel(); if (_notifCh) {
        await sendSlackMessage(
          _notifCh,
          `\u26A0\uFE0F Task overdue da 3+ giorni: "${taskTitle}" (${assignee}). Necessario intervento.`,
        );
      }
      break;
    }
    case 4: {
      // L4: Critical — AI recommendation
      let recommendation = "";
      try {
        recommendation = await agent.think(
          `Il task "${taskTitle}" assegnato a ${assignee} e' overdue da 7+ giorni. Suggerisci un'azione concreta: riassegnare, cancellare, riprioritizzare, o escalare al management. Rispondi in modo breve e diretto.`,
        );
      } catch {
        recommendation = "Impossibile generare raccomandazione AI.";
      }

      await notifyAssigneeAndOwner(
        assignedTo ?? null,
        `\uD83D\uDEA8 ESCALATION CRITICA: Task "${taskTitle}" (${assignee}) — overdue da 7+ giorni\n\n\uD83E\uDD16 Raccomandazione: ${recommendation}`,
      );
      break;
    }
  }
}
