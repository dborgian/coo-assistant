import type { Bot } from "grammy";
import { and, eq, inArray, isNull, sql, gte } from "drizzle-orm";
import { agent } from "../core/agent.js";
import { config } from "../config.js";
import { db } from "../models/database.js";
import { employees, tasks, messageLogs } from "../models/schema.js";
import { getTodayEvents } from "./calendar-sync.js";
import { getTeamWorkload } from "./workload-tracker.js";
import { logger } from "../utils/logger.js";

export async function runProactiveCheck(bot: Bot): Promise<void> {
  const now = new Date();

  // Gather operational context
  const [activeTasks, allEmployees, workload] = await Promise.all([
    db.select().from(tasks).where(inArray(tasks.status, ["pending", "in_progress"])),
    db.select().from(employees).where(eq(employees.isActive, true)),
    getTeamWorkload().catch(() => []),
  ]);

  const overdueTasks = activeTasks.filter(
    (t) => t.dueDate && new Date(t.dueDate) < now,
  );

  const unassignedWithDeadline = activeTasks.filter(
    (t) => !t.assignedTo && t.dueDate,
  );

  const urgentUnassigned = unassignedWithDeadline.filter((t) => {
    const daysUntil = t.dueDate
      ? (new Date(t.dueDate).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
      : 999;
    return daysUntil <= 3;
  });

  const overloadedEmployees = workload.filter((w) => w.workloadScore >= 0.7);

  // Only bother AI if there are actionable issues
  const issues: string[] = [];

  if (urgentUnassigned.length) {
    issues.push(
      `${urgentUnassigned.length} task non assegnati con scadenza entro 3 giorni: ${urgentUnassigned.map((t) => `"${t.title}"`).join(", ")}`,
    );
  }

  if (overloadedEmployees.length) {
    issues.push(
      `Employee sovraccarichi: ${overloadedEmployees.map((w) => `${w.employeeName} (${(w.workloadScore * 100).toFixed(0)}%)`).join(", ")}`,
    );
  }

  if (overdueTasks.length > 3) {
    issues.push(`${overdueTasks.length} task overdue totali nel sistema`);
  }

  // Check for tasks in_progress a long time but recently updated (not stale, but lingering)
  const longRunning = activeTasks.filter((t) => {
    if (t.status !== "in_progress") return false;
    const createdDaysAgo = (now.getTime() - new Date(t.createdAt!).getTime()) / (1000 * 60 * 60 * 24);
    return createdDaysAgo > 7;
  });

  if (longRunning.length) {
    issues.push(
      `${longRunning.length} task in_progress da piu' di 7 giorni: ${longRunning.slice(0, 3).map((t) => `"${t.title}"`).join(", ")}${longRunning.length > 3 ? "..." : ""}`,
    );
  }

  if (!issues.length) {
    logger.debug("Proactive check: no issues found");
    return;
  }

  // Ask AI for recommendations
  try {
    const recommendation = await agent.think(
      `Sei il COO AI. Analizza questi problemi operativi e suggerisci azioni concrete e immediate per ognuno. Sii diretto e pratico, max 3 righe per problema. Rispondi in italiano.`,
      {
        issues,
        team_size: allEmployees.length,
        total_active_tasks: activeTasks.length,
        total_overdue: overdueTasks.length,
        workload_summary: workload.map((w) => ({
          name: w.employeeName,
          assigned: w.tasksAssigned,
          overdue: w.tasksOverdue,
          score: `${(w.workloadScore * 100).toFixed(0)}%`,
        })),
      },
    );

    if (recommendation && recommendation.trim().length > 20) {
      await bot.api.sendMessage(
        config.TELEGRAM_OWNER_CHAT_ID,
        `\uD83E\uDD16 COO AI — Check Proattivo\n\n${recommendation}`,
      );
      logger.info({ issueCount: issues.length }, "Proactive check: recommendations sent");
    }
  } catch (err) {
    logger.error({ err }, "Proactive check AI recommendation failed");
  }
}

export async function generateWeeklyDigest(bot: Bot): Promise<void> {
  const now = new Date();
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);

  // Gather weekly stats
  const [completedThisWeek] = await db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(
      and(
        eq(tasks.status, "done"),
        gte(tasks.updatedAt, weekAgo),
      ),
    );

  const [createdThisWeek] = await db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(gte(tasks.createdAt, weekAgo));

  const activeTasks = await db
    .select()
    .from(tasks)
    .where(inArray(tasks.status, ["pending", "in_progress"]));

  const overdue = activeTasks.filter(
    (t) => t.dueDate && new Date(t.dueDate) < now,
  );

  const [slackMsgCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(messageLogs)
    .where(
      and(
        eq(messageLogs.source, "slack"),
        gte(messageLogs.receivedAt, weekAgo),
      ),
    );

  const workload = await getTeamWorkload().catch(() => []);

  const digest = await agent.think(
    `Genera un digest settimanale delle operazioni. Scrivi come un COO che fa il punto della settimana al founder. Evidenzia trend positivi e negativi, rischi, e suggerisci priorita per la prossima settimana. Max 800 caratteri.`,
    {
      period: `${weekAgo.toISOString().split("T")[0]} — ${now.toISOString().split("T")[0]}`,
      tasks_completed: Number(completedThisWeek?.count ?? 0),
      tasks_created: Number(createdThisWeek?.count ?? 0),
      tasks_active: activeTasks.length,
      tasks_overdue: overdue.length,
      slack_messages: Number(slackMsgCount?.count ?? 0),
      team_workload: workload.map((w) => ({
        name: w.employeeName,
        assigned: w.tasksAssigned,
        completed: w.tasksCompleted,
        overdue: w.tasksOverdue,
      })),
    },
  );

  try {
    await bot.api.sendMessage(
      config.TELEGRAM_OWNER_CHAT_ID,
      `\uD83D\uDCCA Digest Settimanale\n\n${digest}`,
    );
    logger.info("Weekly digest sent");
  } catch (err) {
    logger.error({ err }, "Failed to send weekly digest");
  }
}
