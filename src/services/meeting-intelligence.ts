import { eq, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../models/database.js";
import { employees } from "../models/schema.js";
import { sendOwnerNotification } from "../utils/notify.js";
import { getTodayEvents } from "./calendar-sync.js";
import { logger } from "../utils/logger.js";

export async function detectMeetingOverload(): Promise<void> {
  const events = await getTodayEvents().catch(() => []);
  if (!events.length) return;

  let totalHoursToday = 0;
  for (const e of events) {
    if (e.start && e.end) {
      const duration = (new Date(e.end).getTime() - new Date(e.start).getTime()) / (1000 * 60 * 60);
      totalHoursToday += duration;
    }
  }

  if (totalHoursToday > 5) {
    await sendOwnerNotification(`\u26A0\uFE0F Meeting overload oggi: ${Math.round(totalHoursToday * 10) / 10}h di meeting (${events.length} eventi). Considera di liberare tempo per deep work.`);
  }
}

export async function getMeetingStats(): Promise<string> {
  const events = await getTodayEvents().catch(() => []);

  if (!events.length) return "Nessun meeting oggi.";

  let totalMinutes = 0;
  const eventList: string[] = [];

  for (const e of events) {
    const duration = e.start && e.end
      ? Math.round((new Date(e.end).getTime() - new Date(e.start).getTime()) / 60000)
      : 0;
    totalMinutes += duration;

    const startTime = e.start ? new Date(e.start).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", timeZone: config.TIMEZONE || "Europe/Rome" }) : "?";
    eventList.push(`- ${startTime}: ${e.summary} (${duration} min)`);
  }

  const totalHours = Math.round(totalMinutes / 6) / 10;
  const freeHours = Math.max(0, 8 - totalHours);

  return `Meeting oggi: ${events.length} eventi, ${totalHours}h totali\nTempo libero stimato: ${freeHours}h\n\n${eventList.join("\n")}`;
}
