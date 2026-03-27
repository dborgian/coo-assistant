import { google } from "googleapis";
import { eq } from "drizzle-orm";
import { getGoogleAuth, isGoogleConfigured } from "../core/google-auth.js";
import type { GoogleAuth } from "../core/google-auth.js";
import { db } from "../models/database.js";
import { tasks } from "../models/schema.js";
import { logger } from "../utils/logger.js";

const DEFAULT_TASK_LIST = "@default";

function getTasksClient(authOverride?: GoogleAuth | null) {
  const auth = authOverride ?? getGoogleAuth();
  if (!auth) return null;
  return google.tasks({ version: "v1", auth });
}

/**
 * Create a Google Task from a DB task and save the googleTaskId back.
 */
export async function createGoogleTask(taskId: string): Promise<string | null> {
  if (!isGoogleConfigured()) return null;

  const client = getTasksClient();
  if (!client) return null;

  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task) return null;

  try {
    const res = await client.tasks.insert({
      tasklist: DEFAULT_TASK_LIST,
      requestBody: {
        title: task.title,
        notes: task.description ?? undefined,
        due: task.dueDate ? new Date(task.dueDate).toISOString() : undefined,
      },
    });

    const googleTaskId = res.data.id ?? null;
    if (googleTaskId) {
      await db.update(tasks).set({ googleTaskId, updatedAt: new Date() }).where(eq(tasks.id, taskId));
      logger.info({ taskId, googleTaskId }, "Google Task created");
    }
    return googleTaskId;
  } catch (err) {
    logger.error({ err, taskId }, "Failed to create Google Task");
    return null;
  }
}

/**
 * Mark a Google Task as completed.
 */
export async function completeGoogleTask(taskId: string): Promise<void> {
  if (!isGoogleConfigured()) return;

  const client = getTasksClient();
  if (!client) return;

  const [task] = await db.select({ googleTaskId: tasks.googleTaskId }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task?.googleTaskId) return;

  try {
    await client.tasks.patch({
      tasklist: DEFAULT_TASK_LIST,
      task: task.googleTaskId,
      requestBody: { status: "completed" },
    });
    logger.info({ taskId, googleTaskId: task.googleTaskId }, "Google Task completed");
  } catch (err) {
    logger.error({ err, taskId }, "Failed to complete Google Task");
  }
}

/**
 * Update a Google Task (title, notes, due date).
 */
export async function updateGoogleTask(taskId: string, updates: { title?: string; description?: string; dueDate?: Date | null }): Promise<void> {
  if (!isGoogleConfigured()) return;

  const client = getTasksClient();
  if (!client) return;

  const [task] = await db.select({ googleTaskId: tasks.googleTaskId }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task?.googleTaskId) return;

  try {
    const body: Record<string, string | undefined> = {};
    if (updates.title) body.title = updates.title;
    if (updates.description !== undefined) body.notes = updates.description ?? undefined;
    if (updates.dueDate !== undefined) body.due = updates.dueDate ? updates.dueDate.toISOString() : undefined;

    await client.tasks.patch({
      tasklist: DEFAULT_TASK_LIST,
      task: task.googleTaskId,
      requestBody: body,
    });
    logger.info({ taskId, googleTaskId: task.googleTaskId }, "Google Task updated");
  } catch (err) {
    logger.error({ err, taskId }, "Failed to update Google Task");
  }
}

/**
 * Delete a Google Task.
 */
export async function deleteGoogleTask(taskId: string): Promise<void> {
  if (!isGoogleConfigured()) return;

  const client = getTasksClient();
  if (!client) return;

  const [task] = await db.select({ googleTaskId: tasks.googleTaskId }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task?.googleTaskId) return;

  try {
    await client.tasks.delete({
      tasklist: DEFAULT_TASK_LIST,
      task: task.googleTaskId,
    });
    await db.update(tasks).set({ googleTaskId: null, updatedAt: new Date() }).where(eq(tasks.id, taskId));
    logger.info({ taskId }, "Google Task deleted");
  } catch (err) {
    logger.error({ err, taskId }, "Failed to delete Google Task");
  }
}
