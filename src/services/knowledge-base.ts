import { and, eq, gte, sql } from "drizzle-orm";
import { agent } from "../core/agent.js";
import { db } from "../models/database.js";
import { intelligenceEvents, messageLogs } from "../models/schema.js";
import { logger } from "../utils/logger.js";

export async function extractKnowledgeBatch(): Promise<void> {
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - 6);

  const messages = await db
    .select()
    .from(messageLogs)
    .where(
      and(
        eq(messageLogs.analyzed, false),
        gte(messageLogs.receivedAt, cutoff),
      ),
    )
    .limit(200);

  if (messages.length < 5) return; // Not enough to analyze

  const digest = messages.map((m) =>
    `[${m.chatTitle ?? "?"}] ${m.senderName}: ${m.content.slice(0, 200)}`,
  ).join("\n");

  try {
    const result = await agent.think(
      `Dalle conversazioni seguenti, estrai fatti rilevanti sull'azienda. Categorie: client (preferenze/requisiti clienti), process (processi interni), technical (decisioni tecniche), team (preferenze del team), lesson (lezioni apprese).
Restituisci SOLO JSON: [{"fact": "...", "category": "client|process|technical|team|lesson", "confidence": 0.0-1.0}]
Estrai SOLO se confidence > 0.7. Skip small talk. Se non c'e' nulla di rilevante, restituisci [].`,
      { conversations: digest },
    );

    const start = result.indexOf("[");
    const end = result.lastIndexOf("]") + 1;
    if (start < 0 || end <= start) return;

    const facts: Array<{ fact: string; category: string; confidence: number }> = JSON.parse(result.slice(start, end));

    for (const f of facts) {
      if (f.confidence < 0.7) continue;

      // Check for duplicate
      const [existing] = await db
        .select({ id: intelligenceEvents.id })
        .from(intelligenceEvents)
        .where(
          and(
            eq(intelligenceEvents.type, "knowledge"),
            sql`${intelligenceEvents.content} ILIKE ${"%" + f.fact.slice(0, 50) + "%"}`,
          ),
        )
        .limit(1);

      if (existing) continue;

      await db.insert(intelligenceEvents).values({
        type: "knowledge",
        content: f.fact,
        status: "active",
        metadata: { category: f.category, confidence: f.confidence },
      });
    }

    logger.info({ extracted: facts.length }, "Knowledge batch extracted");
  } catch (err) {
    logger.error({ err }, "Knowledge extraction failed");
  }
}

export async function queryKnowledge(query: string, category?: string): Promise<string> {
  const conditions = [eq(intelligenceEvents.type, "knowledge"), eq(intelligenceEvents.status, "active")];

  const entries = await db
    .select()
    .from(intelligenceEvents)
    .where(and(...conditions))
    .limit(50);

  if (!entries.length) return "Knowledge base vuota. I dati si accumulano nel tempo dalle conversazioni.";

  const filtered = category && category !== "all"
    ? entries.filter((e) => (e.metadata as any)?.category === category)
    : entries;

  if (!filtered.length) return `Nessuna conoscenza nella categoria "${category}".`;

  // Use AI to find relevant entries
  try {
    const result = await agent.think(
      `L'utente chiede: "${query}". Dalle seguenti conoscenze aziendali, restituisci SOLO quelle rilevanti alla domanda. Rispondi in modo narrativo e conciso.`,
      { knowledge: filtered.map((e) => ({ fact: e.content, category: (e.metadata as any)?.category })) },
    );
    return result;
  } catch {
    return filtered.map((e) => `- [${(e.metadata as any)?.category}] ${e.content}`).join("\n");
  }
}
