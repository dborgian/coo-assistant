import { google } from "googleapis";
import { eq } from "drizzle-orm";
import type { Bot } from "grammy";
import { config } from "../config.js";
import { getGoogleAuth, isGoogleConfigured } from "../core/google-auth.js";
import type { GoogleAuth } from "../core/google-auth.js";
import { logger } from "../utils/logger.js";

export async function deleteCalendarEvent(
  eventId: string,
  authOverride?: GoogleAuth | null,
  calendarId = "primary",
): Promise<boolean> {
  const auth = authOverride ?? getGoogleAuth();
  if (!auth) return false;

  const calendar = google.calendar({ version: "v3", auth });
  try {
    await calendar.events.delete({ calendarId, eventId });
    return true;
  } catch (err) {
    logger.debug({ err, eventId }, "Failed to delete calendar event (may already be deleted)");
    return false;
  }
}

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
  organizer?: string;
}

export async function getTodayEvents(authOverride?: GoogleAuth | null, calendarId = "primary"): Promise<CalendarEvent[]> {
  const auth = authOverride ?? getGoogleAuth();
  if (!auth) return [];

  const calendar = google.calendar({ version: "v3", auth });

  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);

  try {
    const res = await calendar.events.list({
      calendarId,
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      timeZone: config.TIMEZONE,
    });

    return (res.data.items ?? []).map((e) => ({
      id: e.id ?? "",
      summary: e.summary ?? "(no title)",
      start: e.start?.dateTime ?? e.start?.date ?? "",
      end: e.end?.dateTime ?? e.end?.date ?? "",
      location: e.location ?? undefined,
      description: e.description ?? undefined,
      organizer: e.organizer?.email ?? undefined,
    }));
  } catch (err) {
    logger.error({ err }, "Failed to fetch calendar events");
    return [];
  }
}

export async function getTeamEvents(): Promise<{ employee: string; events: CalendarEvent[] }[]> {
  const { db } = await import("../models/database.js");
  const { employees } = await import("../models/schema.js");
  const { getUserGoogleAuth } = await import("../core/google-auth.js");

  const emps = await db
    .select({ name: employees.name, googleRefreshToken: employees.googleRefreshToken })
    .from(employees)
    .where(eq(employees.isActive, true));

  const results: { employee: string; events: CalendarEvent[] }[] = [];
  for (const emp of emps) {
    if (!emp.googleRefreshToken) continue;
    try {
      const auth = getUserGoogleAuth(emp.googleRefreshToken);
      const events = await getTodayEvents(auth, "primary");
      results.push({ employee: emp.name, events });
    } catch (err) {
      logger.warn({ err, employee: emp.name }, "Failed to fetch calendar for employee");
    }
  }
  return results;
}

function detectConflicts(events: CalendarEvent[]): [CalendarEvent, CalendarEvent][] {
  const conflicts: [CalendarEvent, CalendarEvent][] = [];
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const a = events[i];
      const b = events[j];
      if (a.end > b.start && a.start < b.end) {
        conflicts.push([a, b]);
      }
    }
  }
  return conflicts;
}

function getUpcomingSoon(events: CalendarEvent[], withinMinutes = 15): CalendarEvent[] {
  const now = new Date();
  const threshold = new Date(now.getTime() + withinMinutes * 60_000);
  return events.filter((e) => {
    const start = new Date(e.start);
    return start > now && start <= threshold;
  });
}

export async function checkUpcomingEvents(bot: Bot): Promise<void> {
  if (!isGoogleConfigured()) {
    logger.debug("Calendar check skipped — Google not configured");
    return;
  }

  const events = await getTodayEvents();
  if (events.length === 0) return;

  // Notify about events starting soon
  const upcoming = getUpcomingSoon(events);
  for (const ev of upcoming) {
    const time = new Date(ev.start).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
    let msg = `\u23F0 <b>Meeting tra 15 min</b>\n${ev.summary} alle ${time}`;
    if (ev.location) msg += `\n\uD83D\uDCCD ${ev.location}`;
    await bot.api.sendMessage(config.TELEGRAM_OWNER_CHAT_ID, msg, { parse_mode: "HTML" });
  }

  // Notify about conflicts
  const conflicts = detectConflicts(events);
  for (const [a, b] of conflicts) {
    const msg = `\u26A0\uFE0F <b>Conflitto calendario</b>\n"${a.summary}" e "${b.summary}" si sovrappongono!`;
    await bot.api.sendMessage(config.TELEGRAM_OWNER_CHAT_ID, msg, { parse_mode: "HTML" });
  }
}
