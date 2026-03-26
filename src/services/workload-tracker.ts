import { and, eq, inArray, sql, gte } from "drizzle-orm";
import { db } from "../models/database.js";
import { employees, employeeMetrics, messageLogs, tasks } from "../models/schema.js";
import { logger } from "../utils/logger.js";

export interface WorkloadSummary {
  employeeName: string;
  tasksAssigned: number;
  tasksCompleted: number;
  tasksOverdue: number;
  avgCompletionDays: number | null;
  slackMessages: number;
  workloadScore: number;
}

export async function updateWorkloadMetrics(): Promise<void> {
  const today = new Date().toISOString().split("T")[0];
  const now = new Date();

  const activeEmployees = await db
    .select()
    .from(employees)
    .where(eq(employees.isActive, true));

  for (const emp of activeEmployees) {
    const [assigned] = await db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(
        and(
          eq(tasks.assignedTo, emp.id),
          inArray(tasks.status, ["pending", "in_progress"]),
        ),
      );

    const [completed] = await db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(
        and(
          eq(tasks.assignedTo, emp.id),
          eq(tasks.status, "done"),
          sql`${tasks.updatedAt}::date = ${today}`,
        ),
      );

    const [overdue] = await db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(
        and(
          eq(tasks.assignedTo, emp.id),
          inArray(tasks.status, ["pending", "in_progress"]),
          sql`${tasks.dueDate} < NOW()`,
        ),
      );

    // Average completion time (last 30 days)
    const [avgRow] = await db
      .select({
        avg: sql<number>`AVG(EXTRACT(EPOCH FROM (${tasks.updatedAt} - ${tasks.createdAt})) / 86400)`,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.assignedTo, emp.id),
          eq(tasks.status, "done"),
          gte(tasks.updatedAt, new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)),
        ),
      );

    // Slack messages today
    const [slackRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(messageLogs)
      .where(
        and(
          eq(messageLogs.source, "slack"),
          eq(messageLogs.employeeId, emp.id),
          sql`${messageLogs.receivedAt}::date = ${today}`,
        ),
      );

    const tasksAssigned = Number(assigned?.count ?? 0);
    const tasksCompleted = Number(completed?.count ?? 0);
    const tasksOverdue = Number(overdue?.count ?? 0);
    const avgCompletionDays = avgRow?.avg ? Number(avgRow.avg) : null;
    const slackMessages = Number(slackRow?.count ?? 0);

    // Workload score: normalized 0-1
    // Higher = more overloaded
    const rawScore =
      tasksAssigned * 0.4 + tasksOverdue * 0.3 + (avgCompletionDays ?? 0) * 0.3;
    const workloadScore = Math.min(1, rawScore / 10); // normalize to 0-1

    // Upsert: delete existing for today, insert new
    await db.delete(employeeMetrics).where(
      and(
        eq(employeeMetrics.employeeId, emp.id),
        eq(employeeMetrics.date, today),
      ),
    );

    await db.insert(employeeMetrics).values({
      employeeId: emp.id,
      date: today,
      tasksAssigned,
      tasksCompleted,
      tasksOverdue,
      avgCompletionDays,
      slackMessages,
      emailsSent: 0,
      workloadScore,
    });

    logger.debug({ employee: emp.name, workloadScore, tasksAssigned, tasksOverdue }, "Workload metrics updated");
  }

  logger.info({ employees: activeEmployees.length }, "Workload metrics updated for all employees");
}

export async function getTeamWorkload(): Promise<WorkloadSummary[]> {
  const today = new Date().toISOString().split("T")[0];

  const activeEmployees = await db
    .select()
    .from(employees)
    .where(eq(employees.isActive, true));

  const summaries: WorkloadSummary[] = [];

  for (const emp of activeEmployees) {
    // Try to get today's metrics, otherwise calculate live
    const [metrics] = await db
      .select()
      .from(employeeMetrics)
      .where(
        and(
          eq(employeeMetrics.employeeId, emp.id),
          eq(employeeMetrics.date, today),
        ),
      )
      .limit(1);

    if (metrics) {
      summaries.push({
        employeeName: emp.name,
        tasksAssigned: metrics.tasksAssigned ?? 0,
        tasksCompleted: metrics.tasksCompleted ?? 0,
        tasksOverdue: metrics.tasksOverdue ?? 0,
        avgCompletionDays: metrics.avgCompletionDays,
        slackMessages: metrics.slackMessages ?? 0,
        workloadScore: metrics.workloadScore ?? 0,
      });
    } else {
      // Live calculation
      const [assigned] = await db
        .select({ count: sql<number>`count(*)` })
        .from(tasks)
        .where(
          and(
            eq(tasks.assignedTo, emp.id),
            inArray(tasks.status, ["pending", "in_progress"]),
          ),
        );

      const [overdueRow] = await db
        .select({ count: sql<number>`count(*)` })
        .from(tasks)
        .where(
          and(
            eq(tasks.assignedTo, emp.id),
            inArray(tasks.status, ["pending", "in_progress"]),
            sql`${tasks.dueDate} < NOW()`,
          ),
        );

      const ta = Number(assigned?.count ?? 0);
      const to = Number(overdueRow?.count ?? 0);

      summaries.push({
        employeeName: emp.name,
        tasksAssigned: ta,
        tasksCompleted: 0,
        tasksOverdue: to,
        avgCompletionDays: null,
        slackMessages: 0,
        workloadScore: Math.min(1, (ta * 0.4 + to * 0.3) / 10),
      });
    }
  }

  return summaries;
}
