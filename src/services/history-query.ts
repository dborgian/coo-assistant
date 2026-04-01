import { and, eq, gte, lte, desc, sql, inArray } from "drizzle-orm";
import { db } from "../models/database.js";
import { employees, tasks, messageLogs, dailyReports } from "../models/schema.js";

export interface DateRange {
  start: Date;
  end: Date;
}

// --- Date Parsing ---

export function parseDateKeywords(query: string): DateRange | null {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const q = query.toLowerCase();

  if (q.includes("ieri") || q.includes("yesterday")) {
    const start = new Date(today);
    start.setDate(start.getDate() - 1);
    return { start, end: today };
  }

  if (q.includes("settimana") || q.includes("week") || q.includes("questa settimana")) {
    const dayOfWeek = today.getDay();
    const monday = new Date(today);
    monday.setDate(today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
    const end = new Date(now);
    end.setDate(end.getDate() + 1);
    return { start: monday, end };
  }

  if (q.includes("scorsa settimana") || q.includes("last week") || q.includes("settimana scorsa")) {
    const dayOfWeek = today.getDay();
    const thisMonday = new Date(today);
    thisMonday.setDate(today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
    const lastMonday = new Date(thisMonday);
    lastMonday.setDate(lastMonday.getDate() - 7);
    return { start: lastMonday, end: thisMonday };
  }

  if (q.includes("oggi") || q.includes("today")) {
    const end = new Date(today);
    end.setDate(end.getDate() + 1);
    return { start: today, end };
  }

  if (q.includes("mese") || q.includes("month") || q.includes("questo mese")) {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now);
    end.setDate(end.getDate() + 1);
    return { start, end };
  }

  // Try to match specific date pattern YYYY-MM-DD
  const dateMatch = query.match(/(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) {
    const start = new Date(dateMatch[1]);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { start, end };
  }

  return null;
}

// --- Employee Name Detection ---

export async function findEmployeeInQuery(query: string): Promise<{ id: string; name: string } | null> {
  const allEmployees = await db
    .select({ id: employees.id, name: employees.name })
    .from(employees)
    .where(eq(employees.isActive, true));

  const q = query.toLowerCase();
  for (const emp of allEmployees) {
    if (q.includes(emp.name.toLowerCase())) {
      return emp;
    }
  }
  return null;
}

// --- Data Fetchers ---

export async function getActivityByDateRange(range: DateRange) {
  const [messages, taskList, reports] = await Promise.all([
    db.select().from(messageLogs)
      .where(and(gte(messageLogs.receivedAt, range.start), lte(messageLogs.receivedAt, range.end)))
      .orderBy(desc(messageLogs.receivedAt))
      .limit(100),

    db.select().from(tasks)
      .where(and(gte(tasks.createdAt, range.start), lte(tasks.createdAt, range.end))),

    db.select().from(dailyReports)
      .where(and(
        gte(dailyReports.reportDate, range.start.toISOString().split("T")[0]),
        lte(dailyReports.reportDate, range.end.toISOString().split("T")[0]),
      ))
      .orderBy(desc(dailyReports.createdAt)),
  ]);

  // Group messages by source
  const bySource = new Map<string, number>();
  for (const m of messages) {
    bySource.set(m.source, (bySource.get(m.source) ?? 0) + 1);
  }

  return {
    messages: messages.map((m) => ({
      source: m.source,
      sender: m.senderName,
      channel: m.chatTitle,
      content: m.content.slice(0, 200),
      urgency: m.urgency,
      time: m.receivedAt,
    })),
    message_count_by_source: Object.fromEntries(bySource),
    tasks_created: taskList.map((t) => ({
      title: t.title,
      status: t.status,
      priority: t.priority,
      assignee: t.assignedTo,
    })),
    reports: reports.map((r) => ({
      date: r.reportDate,
      type: r.reportType,
      preview: r.content.slice(0, 200),
    })),
  };
}

export async function getEmployeeActivity(employeeId: string, range: DateRange) {
  const [emp] = await db.select({ id: employees.id, name: employees.name, role: employees.role, email: employees.email }).from(employees).where(eq(employees.id, employeeId)).limit(1);
  if (!emp) return null;

  const [empTasks, empMessages] = await Promise.all([
    db.select().from(tasks).where(eq(tasks.assignedTo, employeeId)),
    db.select().from(messageLogs).where(and(
      gte(messageLogs.receivedAt, range.start),
      lte(messageLogs.receivedAt, range.end),
      sql`(${messageLogs.employeeId} = ${employeeId} OR ${messageLogs.senderName} ILIKE ${"%" + emp.name + "%"})`,
    )).orderBy(desc(messageLogs.receivedAt)).limit(50),
  ]);

  return {
    employee: { name: emp.name, role: emp.role, email: emp.email },
    tasks: empTasks.map((t) => ({
      title: t.title,
      status: t.status,
      priority: t.priority,
      due: t.dueDate,
    })),
    messages: empMessages.map((m) => ({
      source: m.source,
      channel: m.chatTitle,
      content: m.content.slice(0, 200),
      time: m.receivedAt,
    })),
    stats: {
      total_tasks: empTasks.length,
      active_tasks: empTasks.filter((t) => t.status === "pending" || t.status === "in_progress").length,
      done_tasks: empTasks.filter((t) => t.status === "done").length,
      messages_in_period: empMessages.length,
    },
  };
}
