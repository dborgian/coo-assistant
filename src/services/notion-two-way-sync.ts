import type { Bot } from "grammy";
import { and, eq, isNull, isNotNull, sql, inArray, not } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../models/database.js";
import { tasks, employees } from "../models/schema.js";
import { createNotionTask, isNotionConfigured, getNotionTasksViaSearch, updateNotionTaskStatus, updateNotionTaskProperties, archiveNotionPage, extractNotionPageId } from "./notion-sync.js";
import { completeGoogleTask } from "./google-tasks-sync.js";
import { logger } from "../utils/logger.js";

export async function syncTasksToNotion(bot: Bot): Promise<void> {
  if (!isNotionConfigured()) {
    logger.debug("Notion two-way sync skipped — not configured");
    return;
  }

  // Find tasks created in our DB that don't have a Notion externalId.
  // Guard: skip tasks created less than 30s ago to avoid race with agent.ts create_task (which awaits Notion sync).
  const unsyncedTasks = await db
    .select()
    .from(tasks)
    .where(
      and(
        inArray(tasks.source, ["ai", "manual", "recurring"]),
        isNull(tasks.externalId),
        inArray(tasks.status, ["pending", "in_progress"]),
        sql`${tasks.createdAt} < NOW() - INTERVAL '30 seconds'`,
      ),
    );

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
        const pageId = extractNotionPageId(url);
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

  // Sync status changes (done/cancelled) to Notion
  const completedWithNotion = await db
    .select()
    .from(tasks)
    .where(
      and(
        inArray(tasks.status, ["done", "cancelled"]),
        isNotNull(tasks.externalId),
        sql`${tasks.externalId} LIKE 'notion:%' AND ${tasks.externalId} NOT LIKE 'notion-done:%'`,
      ),
    );

  // Also sync property changes (priority, due date) for active tasks
  const activeWithNotion = await db
    .select()
    .from(tasks)
    .where(
      and(
        inArray(tasks.status, ["pending", "in_progress"]),
        isNotNull(tasks.externalId),
        sql`${tasks.externalId} LIKE 'notion:%'`,
        // Only sync recently updated tasks (last 2 minutes to avoid spam)
        sql`${tasks.updatedAt} > NOW() - INTERVAL '2 minutes'`,
      ),
    );

  for (const task of activeWithNotion) {
    const notionPageId = task.externalId!.replace("notion:", "");
    if (!notionPageId || notionPageId.length < 10) continue;

    try {
      const updates: { priority?: string; dueDate?: string } = {};
      if (task.priority) updates.priority = task.priority.charAt(0).toUpperCase() + task.priority.slice(1);
      if (task.dueDate) updates.dueDate = new Date(task.dueDate).toISOString().split("T")[0];
      await updateNotionTaskProperties(notionPageId, updates);
    } catch (err) {
      logger.debug({ err, task: task.title }, "Failed to sync task properties to Notion");
    }
  }

  if (completedWithNotion.length) {
    logger.info({ count: completedWithNotion.length }, "Syncing completed tasks to Notion");
  }

  for (const task of completedWithNotion) {
    const notionPageId = task.externalId!.replace("notion:", "");
    if (!notionPageId || notionPageId.length < 10) continue;

    try {
      // Update status on Notion
      await updateNotionTaskStatus(notionPageId, task.status!);

      // If task was deleted (cancelled), archive the Notion page
      if (task.status === "cancelled") {
        await archiveNotionPage(notionPageId);
      }

      // Clear externalId so we don't sync again
      await db
        .update(tasks)
        .set({ externalId: `notion-done:${notionPageId}` })
        .where(eq(tasks.id, task.id));

      logger.debug({ task: task.title, status: task.status }, "Notion status synced");
    } catch (err) {
      logger.error({ err, task: task.title }, "Failed to sync status to Notion");
    }
  }
}

export async function syncNotionToTasks(bot: Bot): Promise<void> {
  if (!isNotionConfigured()) return;

  try {
    const notionTasks = await getNotionTasksViaSearch();
    if (!notionTasks.length) return;

    let imported = 0;
    let statusUpdated = 0;

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

    for (const nt of notionTasks) {
      // Check if already in our DB by notion ID
      const [existing] = await db
        .select({ id: tasks.id, status: tasks.status, priority: tasks.priority, dueDate: tasks.dueDate })
        .from(tasks)
        .where(sql`${tasks.externalId} LIKE ${"notion:" + nt.id + "%"}`)
        .limit(1);

      if (existing) {
        // Bidirectional sync: propagate status, priority, dueDate changes from Notion to DB
        const notionStatus = statusMap[nt.status] ?? "pending";
        const notionPriority = priorityMap[nt.priority ?? ""] ?? null;
        const notionDueDate = nt.dueDate ? new Date(nt.dueDate) : null;

        const updates: Record<string, unknown> = {};
        if (existing.status !== notionStatus) updates.status = notionStatus;
        if (notionPriority && existing.priority !== notionPriority) updates.priority = notionPriority;
        if (notionDueDate) {
          const existingMs = existing.dueDate ? new Date(existing.dueDate).getTime() : null;
          if (!existingMs || Math.abs(existingMs - notionDueDate.getTime()) > 60_000) {
            updates.dueDate = notionDueDate;
          }
        }

        if (Object.keys(updates).length > 0) {
          updates.updatedAt = new Date();
          await db.update(tasks).set(updates).where(eq(tasks.id, existing.id));
          if (updates.status === "done" || updates.status === "cancelled") {
            completeGoogleTask(existing.id).catch((e) => logger.error({ err: e, taskId: existing.id }, "Google Tasks complete failed on Notion sync"));
          }
          statusUpdated++;
        }
        continue;
      }

      // Check by title (case-insensitive) to avoid duplicates
      const [byTitle] = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(sql`LOWER(${tasks.title}) = LOWER(${nt.title})`)
        .limit(1);

      if (byTitle) continue;

      // Find assignee
      let assignedTo: string | null = null;
      if (nt.assignee) {
        const [emp] = await db
          .select({ id: employees.id })
          .from(employees)
          .where(sql`${employees.name} ILIKE ${"%" + nt.assignee + "%"}`)
          .limit(1);
        assignedTo = emp?.id ?? null;
      }

      await db.insert(tasks).values({
        title: nt.title,
        status: statusMap[nt.status] ?? "pending",
        priority: priorityMap[nt.priority ?? ""] ?? "medium",
        assignedTo,
        dueDate: nt.dueDate ? new Date(nt.dueDate) : null,
        source: "notion",
        externalId: `notion:${nt.id}`,
      });

      imported++;
    }

    if (imported || statusUpdated) {
      logger.info({ imported, statusUpdated }, "Notion to DB sync completed");
      if (imported) {
        await bot.api.sendMessage(
          config.TELEGRAM_OWNER_CHAT_ID,
          `\uD83D\uDD04 Notion sync: ${imported} nuovi task importati${statusUpdated ? `, ${statusUpdated} status aggiornati` : ""}.`,
        ).catch((e) => logger.error({ err: e }, "Telegram notification on Notion sync failed"));
      }
    }
  } catch (err) {
    logger.error({ err }, "Failed to sync Notion to tasks");
  }
}
