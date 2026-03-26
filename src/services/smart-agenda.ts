import type { Bot } from "grammy";
import { and, eq, inArray, sql } from "drizzle-orm";
import { agent } from "../core/agent.js";
import { config } from "../config.js";
import { db } from "../models/database.js";
import { employees, tasks } from "../models/schema.js";
import { getTodayEvents } from "./calendar-sync.js";
import { sendEmail } from "./email-manager.js";
import { logger } from "../utils/logger.js";

export async function generateAndSendAgendas(bot: Bot): Promise<void> {
  const today = new Date().toISOString().split("T")[0];
  const now = new Date();

  const activeEmployees = await db
    .select()
    .from(employees)
    .where(eq(employees.isActive, true));

  if (!activeEmployees.length) return;

  const calendarEvents = await getTodayEvents().catch(() => []);

  for (const emp of activeEmployees) {
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

      // Try Telegram DM first
      if (emp.telegramUserId && !sent) {
        try {
          await bot.api.sendMessage(emp.telegramUserId, agendaContent);
          sent = true;
        } catch {
          logger.debug({ employee: emp.name }, "Telegram DM failed for agenda");
        }
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

    await bot.api.sendMessage(
      config.TELEGRAM_OWNER_CHAT_ID,
      `\uD83C\uDF05 Agende inviate a ${activeEmployees.length} employee.\n` +
      `Task attivi: ${totalTasks.length} | Overdue: ${overdue.length}`,
    );
  } catch (err) {
    logger.error({ err }, "Failed to send agenda summary to founder");
  }
}
