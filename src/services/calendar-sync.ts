import { google } from "googleapis";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { sendOwnerNotification } from "../utils/notify.js";
import { getGoogleAuth, isGoogleConfigured } from "../core/google-auth.js";
import type { GoogleAuth } from "../core/google-auth.js";
import { logger } from "../utils/logger.js";

// Track which event IDs have already been notified today to avoid duplicate alerts
const notifiedEventIds = new Set<string>();
let notifiedDate = new Date().toLocaleDateString("en-CA", { timeZone: config.TIMEZONE || "UTC" });

/**
 * Register a Google Calendar push notification watch.
 * Google will POST to /webhooks/calendar whenever calendar events change.
 * Watch expires in ~7 days — renew every 6 days via cron.
 */
export async function registerCalendarWatch(): Promise<void> {
  if (!isGoogleConfigured()) {
    logger.debug("Calendar watch skipped — Google not configured");
    return;
  }
  if (!config.RAILWAY_PUBLIC_DOMAIN || !config.CALENDAR_WEBHOOK_TOKEN) {
    logger.debug("Calendar watch skipped — RAILWAY_PUBLIC_DOMAIN or CALENDAR_WEBHOOK_TOKEN not set");
    return;
  }

  const auth = getGoogleAuth();
  if (!auth) return;

  const calendar = google.calendar({ version: "v3", auth });
  const address = `https://${config.RAILWAY_PUBLIC_DOMAIN}/webhooks/calendar`;
  const expiration = String(Date.now() + 6 * 24 * 60 * 60 * 1000); // 6 days in ms

  try {
    const res = await calendar.events.watch({
      calendarId: "primary",
      requestBody: {
        id: `coo-watch-${Date.now()}`,
        type: "web_hook",
        address,
        token: config.CALENDAR_WEBHOOK_TOKEN,
        expiration,
      },
    });
    logger.info(
      { channelId: res.data.id, expiration: res.data.expiration },
      "Calendar push watch registered",
    );
  } catch (err) {
    logger.error({ err }, "Failed to register calendar watch");
  }
}

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

/** Compute UTC-absolute boundaries for a given YYYY-MM-DD date in the configured timezone. */
function getDayBoundaries(dateStr: string): { dayStart: Date; dayEnd: Date } {
  const tz = config.TIMEZONE || "UTC";
  const ref = new Date();
  const tzMs = new Date(ref.toLocaleString("en-US", { timeZone: tz })).getTime();
  const utcMs = new Date(ref.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
  const tzOffsetMs = tzMs - utcMs; // positive for UTC+
  return {
    dayStart: new Date(new Date(`${dateStr}T00:00:00Z`).getTime() - tzOffsetMs),
    dayEnd: new Date(new Date(`${dateStr}T23:59:59.999Z`).getTime() - tzOffsetMs),
  };
}

export async function getTodayEvents(authOverride?: GoogleAuth | null, calendarId = "primary", dateStr?: string): Promise<CalendarEvent[]> {
  const auth = authOverride ?? getGoogleAuth();
  if (!auth) return [];

  const calendar = google.calendar({ version: "v3", auth });

  const tz = config.TIMEZONE || "UTC";
  const resolvedDate = dateStr ?? new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const { dayStart, dayEnd } = getDayBoundaries(resolvedDate);

  try {
    const res = await calendar.events.list({
      calendarId,
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      timeZone: tz ?? config.TIMEZONE ?? "UTC",
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

export async function checkUpcomingEvents(): Promise<void> {
  if (!isGoogleConfigured()) {
    logger.debug("Calendar check skipped — Google not configured");
    return;
  }

  const events = await getTodayEvents();
  if (events.length === 0) return;

  // Reset dedup set if date has changed (new day)
  const todayKey = new Date().toLocaleDateString("en-CA", { timeZone: config.TIMEZONE || "UTC" });
  if (todayKey !== notifiedDate) {
    notifiedEventIds.clear();
    notifiedDate = todayKey;
  }

  // Notify about events starting soon (dedup by event ID)
  const upcoming = getUpcomingSoon(events);
  for (const ev of upcoming) {
    if (notifiedEventIds.has(ev.id)) continue;
    notifiedEventIds.add(ev.id);
    const time = new Date(ev.start).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", timeZone: config.TIMEZONE || "Europe/Rome" });
    let msg = `\u23F0 <b>Meeting tra 15 min</b>\n${ev.summary} alle ${time}`;
    if (ev.location) msg += `\n\uD83D\uDCCD ${ev.location}`;
    await sendOwnerNotification(msg);
  }

  // Notify about conflicts (dedup by pair key)
  const conflicts = detectConflicts(events);
  for (const [a, b] of conflicts) {
    const conflictKey = `conflict:${[a.id, b.id].sort().join(":")}`;
    if (notifiedEventIds.has(conflictKey)) continue;
    notifiedEventIds.add(conflictKey);
    const msg = `\u26A0\uFE0F <b>Conflitto calendario</b>\n"${a.summary}" e "${b.summary}" si sovrappongono!`;
    await sendOwnerNotification(msg);
  }
}
