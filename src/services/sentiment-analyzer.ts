import type { Bot } from "grammy";
import { and, eq, gte, sql } from "drizzle-orm";
import { agent } from "../core/agent.js";
import { config } from "../config.js";
import { db } from "../models/database.js";
import { employees, messageLogs, sentimentScores } from "../models/schema.js";
import { logger } from "../utils/logger.js";

export async function analyzeSentimentBatch(bot: Bot): Promise<void> {
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - 4);

  // Get unanalyzed messages from last 4 hours
  const messages = await db
    .select()
    .from(messageLogs)
    .where(
      and(
        eq(messageLogs.analyzed, false),
        gte(messageLogs.receivedAt, cutoff),
      ),
    );

  if (!messages.length) return;

  // Group by sender
  const bySender = new Map<string, typeof messages>();
  for (const m of messages) {
    const key = m.senderName ?? "Unknown";
    if (!bySender.has(key)) bySender.set(key, []);
    bySender.get(key)!.push(m);
  }

  // Batch AI analysis
  const digest = Array.from(bySender, ([sender, msgs]) =>
    `${sender} (${msgs.length} messages):\n${msgs.map((m) => `- ${m.content.slice(0, 150)}`).join("\n")}`,
  ).join("\n\n");

  try {
    const result = await agent.think(
      `Analizza il sentiment di ogni employee basandoti sui loro messaggi. Per ciascuno restituisci:
- score: numero da -1.0 (molto negativo) a 1.0 (molto positivo)
- label: frustrated, stressed, neutral, enthusiastic, disengaged
Rispondi SOLO con JSON valido: [{"name": "...", "score": 0.5, "label": "neutral"}]`,
      { messages: digest },
    );

    // Parse JSON
    const start = result.indexOf("[");
    const end = result.lastIndexOf("]") + 1;
    if (start < 0 || end <= start) {
      logger.debug("Sentiment analysis returned no parseable JSON");
      return;
    }

    const scores: Array<{ name: string; score: number; label: string }> = JSON.parse(result.slice(start, end));
    const today = new Date().toISOString().split("T")[0];

    for (const s of scores) {
      const [emp] = await db
        .select({ id: employees.id })
        .from(employees)
        .where(sql`${employees.name} ILIKE ${"%" + s.name + "%"}`)
        .limit(1);

      if (!emp) continue;

      // Upsert via SQL ON CONFLICT (prevents data loss if insert fails)
      await db.execute(sql`
        INSERT INTO sentiment_scores (id, employee_id, date, score, label, message_count)
        VALUES (gen_random_uuid(), ${emp.id}, ${today}, ${s.score}, ${s.label}, ${bySender.get(s.name)?.length ?? 0})
        ON CONFLICT (employee_id, date) DO UPDATE SET
          score = EXCLUDED.score,
          label = EXCLUDED.label,
          message_count = EXCLUDED.message_count
      `);
    }

    // Mark messages as analyzed
    for (const m of messages) {
      await db.update(messageLogs).set({ analyzed: true }).where(eq(messageLogs.id, m.id));
    }

    logger.info({ employees: scores.length, messages: messages.length }, "Sentiment batch analyzed");
  } catch (err) {
    logger.error({ err }, "Sentiment batch analysis failed");
  }
}

export async function checkSentimentAlerts(bot: Bot): Promise<void> {
  const today = new Date().toISOString().split("T")[0];
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);

  const activeEmployees = await db.select().from(employees).where(eq(employees.isActive, true));
  const alerts: string[] = [];

  for (const emp of activeEmployees) {
    const recent = await db
      .select()
      .from(sentimentScores)
      .where(
        and(eq(sentimentScores.employeeId, emp.id), gte(sentimentScores.date, weekAgo.toISOString().split("T")[0])),
      );

    if (recent.length < 2) continue;

    const avgScore = recent.reduce((sum, r) => sum + r.score, 0) / recent.length;
    const todayScore = recent.find((r) => r.date === today);

    if (todayScore && todayScore.score < avgScore - 0.3) {
      alerts.push(`${emp.name}: sentiment in calo (${todayScore.label}, score ${todayScore.score.toFixed(1)} vs media ${avgScore.toFixed(1)})`);
    }
  }

  if (alerts.length) {
    await bot.api.sendMessage(
      config.TELEGRAM_OWNER_CHAT_ID,
      `\u26A0\uFE0F Sentiment Alert:\n${alerts.join("\n")}`,
    );
  }
}

export async function getTeamSentiment(employeeName?: string, days: number = 7): Promise<string> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const activeEmployees = await db.select().from(employees).where(eq(employees.isActive, true));
  const lines: string[] = [];

  for (const emp of activeEmployees) {
    if (employeeName && !emp.name.toLowerCase().includes(employeeName.toLowerCase())) continue;

    const scores = await db
      .select()
      .from(sentimentScores)
      .where(
        and(eq(sentimentScores.employeeId, emp.id), gte(sentimentScores.date, cutoff.toISOString().split("T")[0])),
      );

    if (!scores.length) {
      lines.push(`${emp.name}: nessun dato sentiment`);
      continue;
    }

    const avg = scores.reduce((s, r) => s + r.score, 0) / scores.length;
    const latest = scores[scores.length - 1];
    const icon = avg >= 0.3 ? "\uD83D\uDFE2" : avg >= -0.1 ? "\uD83D\uDFE1" : "\uD83D\uDD34";
    lines.push(`${icon} ${emp.name}: ${latest.label ?? "neutral"} (score ${avg.toFixed(1)}, ${scores.length} giorni analizzati)`);
  }

  return lines.length ? lines.join("\n") : "Nessun dato sentiment disponibile.";
}
