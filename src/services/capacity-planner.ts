import { google } from "googleapis";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getGoogleAuth } from "../core/google-auth.js";
import { db } from "../models/database.js";
import { employees, tasks } from "../models/schema.js";
import { logger } from "../utils/logger.js";

const WORK_HOURS_PER_DAY = 8;
const FORECAST_DAYS = 5;

export interface CapacitySummary {
  employeeName: string;
  role: string | null;
  scheduledHours: number;
  availableHours: number;
  utilizationPercent: number;
  status: "available" | "balanced" | "overloaded";
  taskCount: number;
  overdueCount: number;
}

async function getCalendarBusyHours(startDate: Date, endDate: Date): Promise<number> {
  const auth = getGoogleAuth();
  if (!auth) return 0;

  const calendar = google.calendar({ version: "v3", auth });
  try {
    const res = await calendar.events.list({
      calendarId: "primary",
      timeMin: startDate.toISOString(),
      timeMax: endDate.toISOString(),
      singleEvents: true,
    });

    let totalMinutes = 0;
    for (const event of res.data.items ?? []) {
      if (event.start?.dateTime && event.end?.dateTime) {
        const duration = (new Date(event.end.dateTime).getTime() - new Date(event.start.dateTime).getTime()) / 60000;
        totalMinutes += duration;
      }
    }
    return totalMinutes / 60;
  } catch {
    return 0;
  }
}

export async function getTeamCapacity(): Promise<CapacitySummary[]> {
  const now = new Date();
  const horizon = new Date(now);
  horizon.setDate(horizon.getDate() + FORECAST_DAYS);

  const totalAvailableHours = WORK_HOURS_PER_DAY * FORECAST_DAYS;

  const activeEmployees = await db
    .select()
    .from(employees)
    .where(eq(employees.isActive, true));

  const summaries: CapacitySummary[] = [];

  for (const emp of activeEmployees) {
    // Count scheduled task hours
    const empTasks = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.assignedTo, emp.id),
          inArray(tasks.status, ["pending", "in_progress"]),
        ),
      );

    let scheduledMinutes = 0;
    for (const t of empTasks) {
      scheduledMinutes += t.estimatedMinutes ?? 60; // default 1h if not estimated
    }
    const scheduledHours = scheduledMinutes / 60;

    const overdueCount = empTasks.filter(
      (t) => t.dueDate && new Date(t.dueDate) < now,
    ).length;

    const utilizationPercent = Math.round((scheduledHours / totalAvailableHours) * 100);

    let status: CapacitySummary["status"] = "available";
    if (utilizationPercent >= 80) status = "overloaded";
    else if (utilizationPercent >= 40) status = "balanced";

    summaries.push({
      employeeName: emp.name,
      role: emp.role,
      scheduledHours: Math.round(scheduledHours * 10) / 10,
      availableHours: Math.round((totalAvailableHours - scheduledHours) * 10) / 10,
      utilizationPercent,
      status,
      taskCount: empTasks.length,
      overdueCount,
    });
  }

  return summaries.sort((a, b) => a.utilizationPercent - b.utilizationPercent);
}

export async function suggestAssignment(estimatedMinutes: number): Promise<string> {
  const capacity = await getTeamCapacity();

  if (!capacity.length) return "Nessun employee attivo nel sistema.";

  // Find least loaded employee
  const best = capacity[0]; // Already sorted by utilization ascending

  if (best.status === "overloaded") {
    return `Tutti gli employee sono sovraccarichi. Il meno carico e' ${best.employeeName} (${best.utilizationPercent}% utilizzo, ${best.availableHours}h libere). Considera di redistribuire il carico o posticipare.`;
  }

  const taskHours = Math.round((estimatedMinutes / 60) * 10) / 10;
  return `Suggerimento: assegna a ${best.employeeName} (${best.role ?? "no role"}) — ${best.utilizationPercent}% carico, ${best.availableHours}h libere nei prossimi 5 giorni. Il task richiede ~${taskHours}h.`;
}
