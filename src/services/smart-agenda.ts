import { and, eq, inArray, sql } from "drizzle-orm";
import { agent } from "../core/agent.js";
import { db } from "../models/database.js";
import { employees, tasks } from "../models/schema.js";
import { getTodayEvents } from "./calendar-sync.js";
import { getUserGoogleAuth } from "../core/google-auth.js";
import { sendEmail } from "./email-manager.js";
import { sendEmployeeNotification, sendOwnerNotification } from "../utils/notify.js";
import { logger } from "../utils/logger.js";

export async function generateAndSendAgendas(): Promise<void> {
  const today = new Date().toISOString().split("T")[0];
  const now = new Date();

  const activeEmployees = await db
    .select({ id: employees.id, name: employees.name, role: employees.role, email: employees.email, googleEmail: employees.googleEmail, googleRefreshToken: employees.googleRefreshToken })
    .from(employees)
    .where(eq(employees.isActive, true));

  if (!activeEmployees.length) return;

  for (const emp of activeEmployees) {
    // Fetch THIS employee's own calendar (empty if they haven't connected Google)
    const empAuth = emp.googleRefreshToken
      ? getUserGoogleAuth(emp.googleRefreshToken)
      : null;
    const calendarEvents = empAuth
      ? await getTodayEvents(empAuth).catch(() => [])
      : [];

    try {
      // Get employee's tasks
      const empTasks = await db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.assignedTo, emp.id),
            inArray(tasks.status, ["pending", "in_progress"]),
          ),
        );

      const overdueTasks = empTasks.filter(
        (t) => t.dueDate && new Date(t.dueDate) < now,
      );

      const scheduledToday = empTasks.filter(
        (t) => t.scheduledStart && new Date(t.scheduledStart).toISOString().split("T")[0] === today,
      );

      const dueTodayTasks = empTasks.filter(
        (t) => t.dueDate && new Date(t.dueDate).toISOString().split("T")[0] === today,
      );

      // Sort by priority
      const priorityOrder: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
      const sortedTasks = [...empTasks].sort(
        (a, b) => (priorityOrder[a.priority ?? "medium"] ?? 2) - (priorityOrder[b.priority ?? "medium"] ?? 2),
      );

      // Generate AI agenda
      const agendaContent = await agent.think(
        `Genera un'agenda giornaliera personalizzata per ${emp.name} (${emp.role ?? "team member"}).
Scrivi in modo amichevole e diretto, come un COO che prepara la giornata per un collega.
Inizia con "Buongiorno ${emp.name}" e poi elenca in ordine di priorita cosa fare oggi.
Se ci sono task overdue, mettili in evidenza all'inizio.
Se ci sono meeting, ricordali con gli orari.
Chiudi con un messaggio motivante breve.
NON usare emoji. Tieni tutto sotto 500 caratteri.`,
        {
          employee: emp.name,
          role: emp.role,
          date: today,
          tasks: sortedTasks.map((t) => ({
            title: t.title,
            status: t.status,
            priority: t.priority,
            due: t.dueDate,
            scheduled: t.scheduledStart,
          })),
          overdue: overdueTasks.map((t) => ({ title: t.title, due: t.dueDate })),
          scheduled_today: scheduledToday.map((t) => ({
            title: t.title,
            start: t.scheduledStart,
            end: t.scheduledEnd,
          })),
          due_today: dueTodayTasks.map((t) => ({ title: t.title, priority: t.priority })),
          calendar_events: calendarEvents.map((e) => ({
            summary: e.summary,
            start: e.start,
            end: e.end,
          })),
        },
      );

      // Send via best available channel
      let sent = false;

      // Try Slack DM first
      if (emp.id && !sent) {
        const ok = await sendEmployeeNotification(emp.id, agendaContent);
        if (ok) sent = true;
      }

      // Try email
      if (!sent && (emp.email || emp.googleEmail)) {
        const email = emp.email || emp.googleEmail!;
        const emailSent = await sendEmail(
          email,
          `Agenda ${today} — ${emp.name}`,
          agendaContent,
        );
        if (emailSent) sent = true;
      }

      if (sent) {
        logger.info({ employee: emp.name }, "Daily agenda sent");
      } else {
        logger.debug({ employee: emp.name }, "No channel available for agenda delivery");
      }
    } catch (err) {
      logger.error({ err, employee: emp.name }, "Failed to generate/send agenda");
    }
  }

  // Also send founder summary
  try {
    const totalTasks = await db
      .select()
      .from(tasks)
      .where(inArray(tasks.status, ["pending", "in_progress"]));

    const overdue = totalTasks.filter((t) => t.dueDate && new Date(t.dueDate) < now);

    await sendOwnerNotification(
      `\uD83C\uDF05 Agende inviate a ${activeEmployees.length} employee.\n` +
      `Task attivi: ${totalTasks.length} | Overdue: ${overdue.length}`,
    );
  } catch (err) {
    logger.error({ err }, "Failed to send agenda summary to founder");
  }
}
