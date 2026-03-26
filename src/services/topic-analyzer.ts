import { and, eq, gte, sql } from "drizzle-orm";
import { agent } from "../core/agent.js";
import { db } from "../models/database.js";
import { clients, messageLogs } from "../models/schema.js";
import { logger } from "../utils/logger.js";

export async function extractDailyTopics(): Promise<string | null> {
  const today = new Date().toISOString().split("T")[0];
  const dayStart = new Date(today + "T00:00:00Z");

  const messages = await db
    .select()
    .from(messageLogs)
    .where(gte(messageLogs.receivedAt, dayStart));

  if (messages.length < 10) return null;

  // Group by channel
  const byChannel = new Map<string, string[]>();
  for (const m of messages) {
    const ch = m.chatTitle ?? "?";
    if (!byChannel.has(ch)) byChannel.set(ch, []);
    byChannel.get(ch)!.push(`${m.senderName}: ${m.content.slice(0, 150)}`);
  }

  const digest = Array.from(byChannel, ([ch, msgs]) =>
    `#${ch} (${msgs.length}):\n${msgs.slice(-20).join("\n")}`,
  ).join("\n\n");

  try {
    const result = await agent.think(
      `Analizza le conversazioni di oggi e identifica:
1. Top 5 argomenti discussi (con breve descrizione)
2. Clienti menzionati e in che contesto
3. Problemi o rischi emergenti
Rispondi in modo conciso, formato lista.`,
      { conversations: digest, total_messages: messages.length },
    );
    return result;
  } catch (err) {
    logger.error({ err }, "Topic extraction failed");
    return null;
  }
}

export async function getClientMentions(days: number = 7): Promise<string> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const allClients = await db.select().from(clients).where(eq(clients.isActive, true));
  if (!allClients.length) return "Nessun client nel sistema.";

  const mentions: Array<{ name: string; count: number }> = [];

  for (const client of allClients) {
    const [row] = await db
      .select({ count: sql<number>`count(*)` })
      .from(messageLogs)
      .where(
        and(
          sql`${messageLogs.content} ILIKE ${"%" + client.name + "%"}`,
          gte(messageLogs.receivedAt, cutoff),
        ),
      );

    const count = Number(row?.count ?? 0);
    if (count > 0) mentions.push({ name: client.name, count });
  }

  if (!mentions.length) return `Nessun client menzionato negli ultimi ${days} giorni.`;

  mentions.sort((a, b) => b.count - a.count);
  return mentions.map((m) => `- ${m.name}: ${m.count} menzioni`).join("\n");
}

export async function getTopics(period: string = "today"): Promise<string> {
  const result = await extractDailyTopics();
  if (!result) return "Non ci sono abbastanza messaggi per estrarre argomenti.";
  return result;
}
