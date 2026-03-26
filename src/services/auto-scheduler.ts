import { google } from "googleapis";
import type { Bot } from "grammy";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { config } from "../config.js";
import { getGoogleAuth, isGoogleConfigured } from "../core/google-auth.js";
import { db } from "../models/database.js";
import { employees, tasks } from "../models/schema.js";
import { logger } from "../utils/logger.js";

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const WORK_START_HOUR = 9;
const WORK_END_HOUR = 18;

interface TimeSlot {
  start: Date;
  end: Date;
}

function isBlocked(task: { blockedBy: string | null }): boolean {
  if (!task.blockedBy) return false;
  try {
    const deps: string[] = JSON.parse(task.blockedBy);
    return deps.length > 0;
  } catch {
    return false;
  }
}

async function checkDependenciesResolved(blockedBy: string): Promise<boolean> {
  try {
    const depIds: string[] = JSON.parse(blockedBy);
    if (!depIds.length) return true;
    const depTasks = await db
      .select({ status: tasks.status })
      .from(tasks)
      .where(inArray(tasks.id, depIds));
    return depTasks.every((t) => t.status === "done" || t.status === "cancelled");
  } catch {
    return true;
  }
}

async function getCalendarBusySlots(startDate: Date, endDate: Date): Promise<TimeSlot[]> {
  const auth = getGoogleAuth();
  if (!auth) return [];

  const calendar = google.calendar({ version: "v3", auth });
  try {
    const res = await calendar.events.list({
      calendarId: "primary",
      timeMin: startDate.toISOString(),
      timeMax: endDate.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    return (res.data.items ?? [])
      .filter((e) => e.start?.dateTime && e.end?.dateTime)
      .map((e) => ({
        start: new Date(e.start!.dateTime!),
        end: new Date(e.end!.dateTime!),
      }));
  } catch (err) {
    logger.error({ err }, "Failed to fetch calendar for scheduling");
    return [];
  }
}

function findFreeSlots(busySlots: TimeSlot[], startDate: Date, endDate: Date, durationMinutes: number): TimeSlot[] {
  const freeSlots: TimeSlot[] = [];
  const current = new Date(startDate);

  while (current < endDate) {
    const dayStart = new Date(current);
    dayStart.setHours(WORK_START_HOUR, 0, 0, 0);
    const dayEnd = new Date(current);
    dayEnd.setHours(WORK_END_HOUR, 0, 0, 0);

    if (dayStart.getDay() === 0 || dayStart.getDay() === 6) {
      current.setDate(current.getDate() + 1);
      continue;
    }

    // Adjust if start is in the past
    const effectiveStart = dayStart < new Date() ? new Date() : dayStart;
    if (effectiveStart >= dayEnd) {
      current.setDate(current.getDate() + 1);
      continue;
    }

    // Find busy periods for this day
    const dayBusy = busySlots.filter(
      (s) => s.start < dayEnd && s.end > effectiveStart,
    ).sort((a, b) => a.start.getTime() - b.start.getTime());

    let cursor = new Date(effectiveStart);
    // Round up to next 15-minute mark
    const mins = cursor.getMinutes();
    if (mins % 15 !== 0) {
      cursor.setMinutes(mins + (15 - (mins % 15)), 0, 0);
    }

    for (const busy of dayBusy) {
      if (cursor < busy.start) {
        const gapMinutes = (busy.start.getTime() - cursor.getTime()) / 60000;
        if (gapMinutes >= durationMinutes) {
          freeSlots.push({
            start: new Date(cursor),
            end: new Date(cursor.getTime() + durationMinutes * 60000),
          });
        }
      }
      if (busy.end > cursor) cursor = new Date(busy.end);
    }

    // After last busy slot
    if (cursor < dayEnd) {
      const gapMinutes = (dayEnd.getTime() - cursor.getTime()) / 60000;
      if (gapMinutes >= durationMinutes) {
        freeSlots.push({
          start: new Date(cursor),
          end: new Date(cursor.getTime() + durationMinutes * 60000),
        });
      }
    }

    current.setDate(current.getDate() + 1);
  }

  return freeSlots;
}

async function createCalendarEvent(
  title: string,
  start: Date,
  end: Date,
): Promise<string | null> {
  const auth = getGoogleAuth();
  if (!auth) return null;

  const calendar = google.calendar({ version: "v3", auth });
  try {
    const res = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary: `[COO] ${title}`,
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
        colorId: "9", // Blueberry
        description: "Auto-scheduled by COO Assistant",
      },
    });
    return res.data.id ?? null;
  } catch (err) {
    logger.error({ err }, "Failed to create calendar event");
    return null;
  }
}

async function deleteCalendarEvent(eventId: string): Promise<void> {
  const auth = getGoogleAuth();
  if (!auth) return;

  const calendar = google.calendar({ version: "v3", auth });
  try {
    await calendar.events.delete({ calendarId: "primary", eventId });
  } catch (err) {
    logger.debug({ err, eventId }, "Failed to delete calendar event (may already be deleted)");
  }
}

export async function autoScheduleTasks(bot: Bot): Promise<void> {
  if (!isGoogleConfigured()) {
    logger.debug("Auto-scheduling skipped — Google not configured");
    return;
  }

  // Get unscheduled tasks with estimated duration and deadline
  const unscheduled = await db
    .select()
    .from(tasks)
    .where(
      and(
        inArray(tasks.status, ["pending", "in_progress"]),
        isNotNull(tasks.dueDate),
        isNotNull(tasks.estimatedMinutes),
        eq(tasks.autoScheduled, false),
      ),
    );

  if (!unscheduled.length) return;

  // Sort by priority then deadline
  const sorted = unscheduled.sort((a, b) => {
    const pa = PRIORITY_RANK[a.priority ?? "medium"] ?? 2;
    const pb = PRIORITY_RANK[b.priority ?? "medium"] ?? 2;
    if (pa !== pb) return pa - pb;
    return new Date(a.dueDate!).getTime() - new Date(b.dueDate!).getTime();
  });

  const now = new Date();
  const schedulingHorizon = new Date(now);
  schedulingHorizon.setDate(schedulingHorizon.getDate() + 14);

  // Fetch calendar busy slots for the horizon
  const busySlots = await getCalendarBusySlots(now, schedulingHorizon);
  const scheduledEvents: TimeSlot[] = [...busySlots]; // Track newly scheduled slots too

  let scheduled = 0;
  const atRisk: string[] = [];

  for (const task of sorted) {
    // Skip blocked tasks
    if (task.blockedBy) {
      const resolved = await checkDependenciesResolved(task.blockedBy);
      if (!resolved) continue;
    }

    const duration = task.estimatedMinutes ?? 60;
    const deadline = new Date(task.dueDate!);

    const freeSlots = findFreeSlots(scheduledEvents, now, deadline, duration);

    if (!freeSlots.length) {
      atRisk.push(`"${task.title}" (scade ${deadline.toLocaleDateString("it-IT")})`);
      continue;
    }

    const slot = freeSlots[0];
    const eventId = await createCalendarEvent(task.title, slot.start, slot.end);

    await db
      .update(tasks)
      .set({
        scheduledStart: slot.start,
        scheduledEnd: slot.end,
        autoScheduled: true,
        calendarEventId: eventId,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, task.id));

    // Add to busy slots so next tasks don't overlap
    scheduledEvents.push(slot);
    scheduled++;
    logger.info({ task: task.title, start: slot.start, end: slot.end }, "Task auto-scheduled");
  }

  if (scheduled || atRisk.length) {
    let message = "";
    if (scheduled) message += `\uD83D\uDCC5 Auto-scheduling: ${scheduled} task piazzati nel calendario.\n`;
    if (atRisk.length) message += `\u26A0\uFE0F Task a rischio (non c'e' abbastanza tempo):\n${atRisk.join("\n")}`;

    try {
      await bot.api.sendMessage(config.TELEGRAM_OWNER_CHAT_ID, message);
    } catch (err) {
      logger.error({ err }, "Failed to send auto-scheduling notification");
    }
  }
}

export async function unscheduleTask(taskId: string): Promise<void> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task) return;

  if (task.calendarEventId) {
    await deleteCalendarEvent(task.calendarEventId);
  }

  await db
    .update(tasks)
    .set({
      scheduledStart: null,
      scheduledEnd: null,
      autoScheduled: false,
      calendarEventId: null,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId));
}
