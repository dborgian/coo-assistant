import type { Bot } from "grammy";
import { and, eq, isNull, sql, inArray } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../models/database.js";
import { tasks, employees } from "../models/schema.js";
import { createNotionTask, isNotionConfigured, getNotionWorkspaceSummary } from "./notion-sync.js";
import { logger } from "../utils/logger.js";

export async function syncTasksToNotion(bot: Bot): Promise<void> {
  if (!isNotionConfigured()) {
    logger.debug("Notion two-way sync skipped — not configured");
    return;
  }

  // Find tasks created in our DB that don't have a Notion externalId
  const unsyncedTasks = await db
    .select()
    .from(tasks)
    .where(
      and(
        inArray(tasks.source, ["ai", "manual", "recurring"]),
        isNull(tasks.externalId),
        inArray(tasks.status, ["pending", "in_progress"]),
      ),
    );

  if (!unsyncedTasks.length) return;

  let synced = 0;

  for (const task of unsyncedTasks) {
    try {
      const url = await createNotionTask(task.title, {
        status: task.status === "in_progress" ? "In Progress" : undefined,
        priority: task.priority
          ? task.priority.charAt(0).toUpperCase() + task.priority.slice(1)
          : undefined,
        dueDate: task.dueDate
          ? new Date(task.dueDate).toISOString().split("T")[0]
          : undefined,
      });

      if (url) {
        // Extract page ID from URL
        const pageId = url.split("/").pop()?.split("-").pop() ?? null;
        await db
          .update(tasks)
          .set({
            source: task.source ?? "ai",
            externalId: pageId ? `notion:${pageId}` : `notion:${url}`,
          })
          .where(eq(tasks.id, task.id));
        synced++;
      }
    } catch (err) {
      logger.error({ err, task: task.title }, "Failed to sync task to Notion");
    }
  }

  if (synced) {
    logger.info({ count: synced }, "Tasks synced to Notion");
  }
}

export async function syncNotionToTasks(bot: Bot): Promise<void> {
  if (!isNotionConfigured()) return;

  try {
    const notionData = await getNotionWorkspaceSummary();
    if (!notionData?.tasks.length) return;

    let imported = 0;

    for (const nt of notionData.tasks) {
      // Check if already in our DB
      const [existing] = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          sql`${tasks.externalId} LIKE ${"notion:%" + (nt as any).id + "%"}`,
        )
        .limit(1);

      if (existing) continue;

      // Also check by exact title to avoid duplicates
      const [byTitle] = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.title, nt.title))
        .limit(1);

      if (byTitle) continue;

      // Find assignee
      let assignedTo: string | null = null;
      if (nt.assignee) {
        const [emp] = await db
          .select({ id: employees.id })
          .from(employees)
          .where(
            sql`${employees.name} ILIKE ${"%" + nt.assignee + "%"}`,
          )
          .limit(1);
        assignedTo = emp?.id ?? null;
      }

      const statusMap: Record<string, string> = {
        "Not started": "pending",
        "In progress": "in_progress",
        "In Progress": "in_progress",
        Done: "done",
        Cancelled: "cancelled",
      };

      const priorityMap: Record<string, string> = {
        Low: "low",
        Medium: "medium",
        High: "high",
        Urgent: "urgent",
      };

      await db.insert(tasks).values({
        title: nt.title,
        status: statusMap[nt.status] ?? "pending",
        priority: priorityMap[nt.priority ?? ""] ?? "medium",
        assignedTo,
        dueDate: nt.dueDate ? new Date(nt.dueDate) : null,
        source: "notion",
        externalId: `notion:${(nt as any).id ?? nt.title}`,
      });

      imported++;
    }

    if (imported) {
      logger.info({ count: imported }, "Tasks imported from Notion");
      try {
        await bot.api.sendMessage(
          config.TELEGRAM_OWNER_CHAT_ID,
          `\uD83D\uDD04 Notion sync: ${imported} nuovi task importati.`,
        );
      } catch (err) {
        logger.error({ err }, "Failed to notify about Notion imports");
      }
    }
  } catch (err) {
    logger.error({ err }, "Failed to sync Notion to tasks");
  }
}
