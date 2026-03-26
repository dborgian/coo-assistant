import type { Bot } from "grammy";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { agent } from "../core/agent.js";
import { config } from "../config.js";
import { db } from "../models/database.js";
import { employees, tasks } from "../models/schema.js";
import { logger } from "../utils/logger.js";

export async function detectStaleTasks(bot: Bot): Promise<void> {
  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

  const staleTasks = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      assignedTo: tasks.assignedTo,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.status, "in_progress"),
        lte(tasks.updatedAt, threeDaysAgo),
      ),
    );

  if (!staleTasks.length) return;

  const lines: string[] = [];
  const criticalTasks: typeof staleTasks = [];

  for (const task of staleTasks) {
    const daysStale = Math.floor(
      (Date.now() - new Date(task.updatedAt!).getTime()) / (1000 * 60 * 60 * 24),
    );

    let assigneeName = "non assegnato";
    if (task.assignedTo) {
      const [emp] = await db
        .select({ name: employees.name })
        .from(employees)
        .where(eq(employees.id, task.assignedTo))
        .limit(1);
      if (emp) assigneeName = emp.name;
    }

    lines.push(`- "${task.title}" — fermo da ${daysStale} giorni (${assigneeName})`);

    if (daysStale >= 7) {
      criticalTasks.push(task);
    }
  }

  let message = `\u26A0\uFE0F TASK FERMI (nessun aggiornamento):\n${lines.join("\n")}`;

  // For tasks stale 7+ days, get AI recommendation
  if (criticalTasks.length) {
    try {
      const recommendation = await agent.think(
        `Questi task sono in_progress senza aggiornamenti da 7+ giorni. Per ognuno suggerisci un'azione concreta: riassegnare, cancellare, riprioritizzare, o chiedere un update all'assignee.\n\n${criticalTasks.map((t) => `- "${t.title}"`).join("\n")}`,
      );
      message += `\n\n\uD83E\uDD16 Raccomandazione AI:\n${recommendation}`;
    } catch (err) {
      logger.error({ err }, "AI recommendation for stale tasks failed");
    }
  }

  try {
    await bot.api.sendMessage(config.TELEGRAM_OWNER_CHAT_ID, message);
    logger.info({ count: staleTasks.length }, "Stale tasks detected and notified");
  } catch (err) {
    logger.error({ err }, "Failed to send stale tasks notification");
  }
}
