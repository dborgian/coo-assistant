import type { Bot } from "grammy";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../models/database.js";
import { tasks } from "../models/schema.js";
import { logger } from "../utils/logger.js";

const PRIORITY_ORDER = ["low", "medium", "high", "urgent"] as const;

function getPriorityIndex(p: string): number {
  return PRIORITY_ORDER.indexOf(p as typeof PRIORITY_ORDER[number]);
}

export async function runAutoPrioritization(bot: Bot): Promise<void> {
  const activeTasks = await db
    .select()
    .from(tasks)
    .where(
      and(
        inArray(tasks.status, ["pending", "in_progress"]),
        isNotNull(tasks.dueDate),
      ),
    );

  if (!activeTasks.length) return;

  const now = Date.now();
  const upgrades: string[] = [];

  for (const task of activeTasks) {
    // Skip blocked tasks
    if (task.blockedBy) {
      try {
        const deps: string[] = JSON.parse(task.blockedBy);
        if (deps.length > 0) continue;
      } catch { /* ignore */ }
    }

    const daysUntilDue = (new Date(task.dueDate!).getTime() - now) / (1000 * 60 * 60 * 24);
    const currentIdx = getPriorityIndex(task.priority ?? "medium");

    let newPriority: string | null = null;

    // Upgrade priority based on approaching deadline
    if (daysUntilDue <= 0) {
      if (currentIdx < 3) newPriority = "urgent";
    } else if (daysUntilDue <= 1) {
      if (currentIdx < 2) newPriority = "high";
    } else if (daysUntilDue <= 3) {
      if (currentIdx < 1) newPriority = "medium";
    }

    // Downgrade priority if deadline was extended far into the future
    if (!newPriority && daysUntilDue > 7 && currentIdx > 1) {
      // urgent with 7+ days → high; high with 7+ days → keep
      if (task.priority === "urgent") newPriority = "high";
    }
    if (!newPriority && daysUntilDue > 14 && currentIdx > 0) {
      if (task.priority === "high") newPriority = "medium";
    }

    if (newPriority && newPriority !== task.priority) {
      await db
        .update(tasks)
        .set({ priority: newPriority, updatedAt: new Date() })
        .where(eq(tasks.id, task.id));

      upgrades.push(`"${task.title}": ${task.priority} -> ${newPriority}`);
      logger.info({ task: task.title, from: task.priority, to: newPriority }, "Task auto-prioritized");
    }
  }

  if (upgrades.length) {
    const message = `\uD83D\uDD04 Auto-prioritizzazione: aggiornati ${upgrades.length} task:\n${upgrades.join("\n")}`;
    try {
      await bot.api.sendMessage(config.TELEGRAM_OWNER_CHAT_ID, message);
    } catch (err) {
      logger.error({ err }, "Failed to send auto-prioritization notification");
    }
  }
}
