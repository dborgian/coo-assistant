import { and, eq, gte, sql } from "drizzle-orm";
import { sendOwnerNotification } from "../utils/notify.js";
import { db } from "../models/database.js";
import { communicationStats, employees, messageLogs } from "../models/schema.js";
import { logger } from "../utils/logger.js";

export async function updateCommunicationStats(): Promise<void> {
  const today = new Date().toISOString().split("T")[0];
  const dayStart = new Date(today + "T00:00:00Z");
  const dayEnd = new Date(today + "T23:59:59Z");

  const activeEmployees = await db.select({ id: employees.id, name: employees.name, slackMemberId: employees.slackMemberId }).from(employees).where(eq(employees.isActive, true));

  for (const emp of activeEmployees) {
    for (const source of ["slack", "telegram"] as const) {
      const empMessages = await db
        .select()
        .from(messageLogs)
        .where(
          and(
            eq(messageLogs.source, source),
            sql`(${messageLogs.senderName} ILIKE ${"%" + emp.name + "%"} OR ${messageLogs.senderId} = ${emp.slackMemberId ?? ""})`,
            gte(messageLogs.receivedAt, dayStart),
          ),
        );

      if (!empMessages.length) continue;

      // Channels active
      const channels = [...new Set(empMessages.map((m) => m.chatTitle).filter(Boolean))];

      // Active hours
      const hourCounts: Record<string, number> = {};
      for (const m of empMessages) {
        const hour = new Date(m.receivedAt!).getHours().toString();
        hourCounts[hour] = (hourCounts[hour] ?? 0) + 1;
      }

      const firstMsg = empMessages.reduce((min, m) =>
        new Date(m.receivedAt!) < new Date(min.receivedAt!) ? m : min,
      );
      const lastMsg = empMessages.reduce((max, m) =>
        new Date(m.receivedAt!) > new Date(max.receivedAt!) ? m : max,
      );

      // Upsert
      await db.delete(communicationStats).where(
        and(
          eq(communicationStats.employeeId, emp.id),
          eq(communicationStats.date, today),
          eq(communicationStats.source, source),
        ),
      );

      await db.insert(communicationStats).values({
        date: today,
        employeeId: emp.id,
        source,
        messagesSent: empMessages.length,
        channelsActive: channels,
        activeHours: hourCounts,
        firstMessageAt: new Date(firstMsg.receivedAt!),
        lastMessageAt: new Date(lastMsg.receivedAt!),
      });
    }
  }

  logger.info("Communication stats updated");
}

export async function detectSilentEmployees(): Promise<void> {
  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

  const activeEmployees = await db.select({ id: employees.id, name: employees.name, slackMemberId: employees.slackMemberId }).from(employees).where(eq(employees.isActive, true));
  const silent: string[] = [];

  for (const emp of activeEmployees) {
    const [recent] = await db
      .select({ count: sql<number>`count(*)` })
      .from(messageLogs)
      .where(
        and(
          sql`(${messageLogs.senderName} ILIKE ${"%" + emp.name + "%"} OR ${messageLogs.senderId} = ${emp.slackMemberId ?? ""})`,
          gte(messageLogs.receivedAt, threeDaysAgo),
        ),
      );

    if (Number(recent?.count ?? 0) === 0) {
      // Check if they were active before
      const [older] = await db
        .select({ count: sql<number>`count(*)` })
        .from(messageLogs)
        .where(
          sql`${messageLogs.senderName} ILIKE ${"%" + emp.name + "%"}`,
        );

      if (Number(older?.count ?? 0) > 0) {
        silent.push(emp.name);
      }
    }
  }

  if (silent.length) {
    await sendOwnerNotification(`\uD83D\uDE36 Employee silenziosi (0 messaggi in 3 giorni):\n${silent.map((n) => `- ${n}`).join("\n")}`);
  }
}

export async function getCommunicationOverview(employeeName?: string, days: number = 7): Promise<string> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const activeEmployees = await db.select({ id: employees.id, name: employees.name, slackMemberId: employees.slackMemberId }).from(employees).where(eq(employees.isActive, true));
  const lines: string[] = [];

  for (const emp of activeEmployees) {
    if (employeeName && !emp.name.toLowerCase().includes(employeeName.toLowerCase())) continue;

    const stats = await db
      .select()
      .from(communicationStats)
      .where(
        and(eq(communicationStats.employeeId, emp.id), gte(communicationStats.date, cutoff.toISOString().split("T")[0])),
      );

    const totalMsgs = stats.reduce((s, r) => s + (r.messagesSent ?? 0), 0);
    const avgResponse = stats.filter((s) => s.avgResponseTimeMinutes).reduce((s, r) => s + (r.avgResponseTimeMinutes ?? 0), 0) / (stats.filter((s) => s.avgResponseTimeMinutes).length || 1);

    lines.push(`${emp.name}: ${totalMsgs} messaggi in ${days}gg${avgResponse > 0 ? `, risposta media: ${Math.round(avgResponse)} min` : ""}`);
  }

  return lines.length ? lines.join("\n") : "Nessun dato comunicazione disponibile.";
}
