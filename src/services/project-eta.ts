import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../models/database.js";
import { tasks } from "../models/schema.js";
import { logger } from "../utils/logger.js";

export interface ProjectETA {
  projectName: string;
  totalTasks: number;
  completedTasks: number;
  activeTasks: number;
  overdueTasks: number;
  avgCompletionDays: number;
  estimatedDaysRemaining: number;
  estimatedCompletionDate: string;
  confidence: "high" | "medium" | "low";
}

export async function getProjectETA(projectKeyword: string): Promise<string> {
  // Find tasks matching the project keyword
  const allTasks = await db
    .select()
    .from(tasks)
    .where(sql`${tasks.title} ILIKE ${"%" + projectKeyword + "%"}`);

  if (!allTasks.length) {
    return `Nessun task trovato per il progetto "${projectKeyword}".`;
  }

  const completed = allTasks.filter((t) => t.status === "done");
  const active = allTasks.filter((t) => t.status === "pending" || t.status === "in_progress");
  const overdue = active.filter((t) => t.dueDate && new Date(t.dueDate) < new Date());

  // Calculate team velocity (tasks completed per week)
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const completedThisWeek = completed.filter(
    (t) => t.updatedAt && new Date(t.updatedAt) >= weekAgo,
  ).length;

  // Average completion time
  let avgDays = 3; // default estimate
  if (completed.length >= 2) {
    const durations = completed
      .filter((t) => t.createdAt && t.updatedAt)
      .map((t) => (new Date(t.updatedAt!).getTime() - new Date(t.createdAt!).getTime()) / (1000 * 60 * 60 * 24));
    if (durations.length) {
      avgDays = durations.reduce((a, b) => a + b, 0) / durations.length;
    }
  }

  const velocity = completedThisWeek || 1; // tasks per week, min 1
  const weeksRemaining = active.length / velocity;
  const daysRemaining = Math.ceil(weeksRemaining * 7);

  const eta = new Date();
  eta.setDate(eta.getDate() + daysRemaining);

  const confidence = completed.length >= 5 ? "high" : completed.length >= 2 ? "medium" : "low";

  return [
    `Progetto: "${projectKeyword}"`,
    `Task totali: ${allTasks.length} (${completed.length} completati, ${active.length} attivi, ${overdue.length} overdue)`,
    `Velocity: ${velocity} task/settimana`,
    `Tempo medio completamento: ${avgDays.toFixed(1)} giorni/task`,
    `ETA completamento: ${eta.toLocaleDateString("it-IT")} (~${daysRemaining} giorni)`,
    `Confidenza: ${confidence}${confidence === "low" ? " (pochi dati storici)" : ""}`,
  ].join("\n");
}
