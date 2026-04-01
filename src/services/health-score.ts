/**
 * Operational Health Score (0–100).
 *
 * A single composite metric that summarises the company's operational state.
 * Used in the daily report and dashboard so the owner gets an at-a-glance
 * signal without reading the full report.
 *
 * Weights:
 *   Task completion rate (this week)   40 pts
 *   Overdue ratio (active tasks)       30 pts
 *   Team workload balance              20 pts
 *   Open commitment count              10 pts
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../models/database.js";
import { intelligenceEvents, tasks } from "../models/schema.js";
import { getTeamWorkload } from "./workload-tracker.js";
import { logger } from "../utils/logger.js";

export interface HealthScore {
  score: number;          // 0–100
  label: "critical" | "poor" | "fair" | "good" | "excellent";
  emoji: string;
  components: {
    completionRate: number;       // 0–100
    overdueRatio: number;         // 0–100 (higher = fewer overdue)
    workloadBalance: number;      // 0–100 (higher = more balanced)
    commitmentHealth: number;     // 0–100 (higher = fewer open)
  };
}

export async function computeHealthScore(): Promise<HealthScore> {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  try {
    // 1. Task completion rate (40 pts)
    const [completedRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(and(eq(tasks.status, "done"), gte(tasks.updatedAt, weekAgo)));
    const [createdRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(gte(tasks.createdAt, weekAgo));
    const completedCount = Number(completedRow?.count ?? 0);
    const createdCount = Number(createdRow?.count ?? 0);
    const completionRate = createdCount > 0
      ? Math.min(1, completedCount / createdCount)
      : 1;

    // 2. Overdue ratio (30 pts) — fraction of active tasks NOT overdue
    const activeTasks = await db
      .select({ dueDate: tasks.dueDate })
      .from(tasks)
      .where(inArray(tasks.status, ["pending", "in_progress"]));
    const overdueCount = activeTasks.filter((t) => t.dueDate && new Date(t.dueDate) < now).length;
    const overdueRatio = activeTasks.length > 0
      ? 1 - overdueCount / activeTasks.length
      : 1;

    // 3. Workload balance (20 pts) — low stddev = balanced team
    const workload = await getTeamWorkload().catch(() => []);
    let workloadBalance = 1;
    if (workload.length > 1) {
      const scores = workload.map((w) => w.workloadScore);
      const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
      const variance = scores.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / scores.length;
      const stddev = Math.sqrt(variance);
      workloadBalance = Math.max(0, 1 - stddev * 2.5);
    }

    // 4. Open commitment health (10 pts) — fewer open = better
    const [openCommitsRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(intelligenceEvents)
      .where(and(eq(intelligenceEvents.type, "commitment"), eq(intelligenceEvents.status, "open")));
    const openCommits = Number(openCommitsRow?.count ?? 0);
    // 0 open = 100%, 5+ open = 0%
    const commitmentHealth = Math.max(0, 1 - openCommits / 5);

    const score = Math.round(
      completionRate * 40 +
      overdueRatio * 30 +
      workloadBalance * 20 +
      commitmentHealth * 10,
    );

    let label: HealthScore["label"] = "excellent";
    let emoji = "🟢";
    if (score < 40) { label = "critical"; emoji = "🔴"; }
    else if (score < 60) { label = "poor"; emoji = "🟠"; }
    else if (score < 75) { label = "fair"; emoji = "🟡"; }
    else if (score < 90) { label = "good"; emoji = "🟢"; }
    else { label = "excellent"; emoji = "✅"; }

    return {
      score,
      label,
      emoji,
      components: {
        completionRate: Math.round(completionRate * 100),
        overdueRatio: Math.round(overdueRatio * 100),
        workloadBalance: Math.round(workloadBalance * 100),
        commitmentHealth: Math.round(commitmentHealth * 100),
      },
    };
  } catch (err) {
    logger.warn({ err }, "computeHealthScore failed — returning neutral score");
    return { score: 50, label: "fair", emoji: "🟡", components: { completionRate: 50, overdueRatio: 50, workloadBalance: 50, commitmentHealth: 50 } };
  }
}

/** Format health score as a one-line summary for Slack/reports. */
export function formatHealthScore(hs: HealthScore): string {
  return `${hs.emoji} *Health Score: ${hs.score}/100* (${hs.label}) — completamento task ${hs.components.completionRate}% | overdue ok ${hs.components.overdueRatio}% | bilanciamento team ${hs.components.workloadBalance}%`;
}
