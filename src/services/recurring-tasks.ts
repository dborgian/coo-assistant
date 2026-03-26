import type { Bot } from "grammy";
import { and, eq, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../models/database.js";
import { tasks } from "../models/schema.js";
import { logger } from "../utils/logger.js";

export async function generateRecurringTasks(bot: Bot): Promise<void> {
  const now = new Date();
  const today = now.toISOString().split("T")[0];
  const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const dayOfMonth = now.getDate();

  // Get all recurring task templates
  const templates = await db
    .select()
    .from(tasks)
    .where(eq(tasks.isRecurring, true));

  if (!templates.length) return;

  let generated = 0;

  for (const template of templates) {
    // Check if recurrence has ended
    if (template.recurrenceEndDate && new Date(template.recurrenceEndDate) < now) {
      continue;
    }

    // Check if this template should generate today
    const pattern = template.recurrencePattern;
    if (!pattern) continue;

    let shouldGenerate = false;

    if (pattern === "daily") {
      shouldGenerate = true;
    } else if (pattern === "weekly") {
      const days: number[] = template.recurrenceDays ? JSON.parse(template.recurrenceDays) : [1]; // default Monday
      shouldGenerate = days.includes(dayOfWeek);
    } else if (pattern === "monthly") {
      const days: number[] = template.recurrenceDays ? JSON.parse(template.recurrenceDays) : [1]; // default 1st
      shouldGenerate = days.includes(dayOfMonth);
    }

    if (!shouldGenerate) continue;

    // Check if instance already exists for today
    const [existing] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.recurrenceParentId, template.id),
          sql`${tasks.createdAt}::date = ${today}`,
        ),
      )
      .limit(1);

    if (existing) continue;

    // Create new instance
    const dueDate = new Date(now);
    dueDate.setHours(23, 59, 59, 0);

    await db.insert(tasks).values({
      title: template.title,
      description: template.description,
      priority: template.priority ?? "medium",
      assignedTo: template.assignedTo,
      dueDate,
      source: "recurring",
      status: "pending",
      recurrenceParentId: template.id,
    });

    generated++;
    logger.info({ task: template.title, pattern }, "Recurring task instance created");
  }

  if (generated) {
    try {
      await bot.api.sendMessage(
        config.TELEGRAM_OWNER_CHAT_ID,
        `\uD83D\uDD04 Generati ${generated} task ricorrenti per oggi.`,
      );
    } catch (err) {
      logger.error({ err }, "Failed to send recurring tasks notification");
    }
  }
}
