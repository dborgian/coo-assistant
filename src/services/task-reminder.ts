import type { Bot } from "grammy";
import { and, eq, inArray, lte, gte, isNotNull } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../models/database.js";
import { employees, tasks } from "../models/schema.js";
import { logger } from "../utils/logger.js";

export async function checkAndSendReminders(bot: Bot): Promise<void> {
  const now = new Date();
  const oneHourLater = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  const oneDayLater = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const nowStr = now.toISOString();

  // Tasks with explicit reminder times
  const dueReminders = db
    .select()
    .from(tasks)
    .where(
      and(
        isNotNull(tasks.reminderAt),
        lte(tasks.reminderAt, oneHourLater),
        eq(tasks.reminderSent, false),
        inArray(tasks.status, ["pending", "in_progress"]),
      ),
    )
    .all();

  // Tasks due within 24 hours
  const dueToday = db
    .select()
    .from(tasks)
    .where(
      and(
        isNotNull(tasks.dueDate),
        lte(tasks.dueDate, oneDayLater),
        gte(tasks.dueDate, nowStr),
        eq(tasks.reminderSent, false),
        inArray(tasks.status, ["pending", "in_progress"]),
      ),
    )
    .all();

  // Deduplicate by task id
  const seen = new Set<number>();
  const tasksToRemind = [...dueReminders, ...dueToday].filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });

  if (!tasksToRemind.length) return;

  for (const task of tasksToRemind) {
    let assignee: { name: string } | undefined;
    if (task.assignedTo) {
      assignee = db
        .select({ name: employees.name })
        .from(employees)
        .where(eq(employees.id, task.assignedTo))
        .get();
    }

    const assigneeText = assignee ? ` (assigned to ${assignee.name})` : "";
    const dueText = task.dueDate
      ? `\nDue: ${new Date(task.dueDate).toLocaleString("en-US", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`
      : "";

    const notification =
      `<b>Task Reminder</b>${assigneeText}\n\n` +
      `<b>${task.title}</b>${dueText}\n` +
      `Priority: ${task.priority}`;

    try {
      await bot.api.sendMessage(config.TELEGRAM_OWNER_CHAT_ID, notification, {
        parse_mode: "HTML",
      });

      db.update(tasks)
        .set({ reminderSent: true })
        .where(eq(tasks.id, task.id))
        .run();

      logger.info(
        { task: task.title, assignee: assignee?.name ?? "unassigned" },
        "Reminder sent",
      );
    } catch (err) {
      logger.error({ err, task: task.title }, "Failed to send reminder");
    }
  }
}
