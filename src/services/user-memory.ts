/**
 * Long-term user memory service.
 *
 * After each bot interaction, claude-haiku-4-5 extracts any preferences or
 * patterns from the conversation and upserts them into the user_memory table.
 * These are then injected into the system prompt so Claude can personalise
 * responses and proactively suggest remembered preferences.
 *
 * Categories:
 *   preference — recurring choices (file format, assignee, report style)
 *   pattern    — behavioural patterns (activity hours, frequent request types)
 *   context    — important facts (ongoing projects, key deadlines mentioned)
 *
 * Confidence increments on each confirmation. When confidence >= 2 the bot
 * proactively suggests the stored preference.
 */
import Anthropic from "@anthropic-ai/sdk";
import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "../models/database.js";
import { userMemory } from "../models/schema.js";
import { logger } from "../utils/logger.js";

const extractor = new Anthropic();


export interface MemoryEntry {
  category: string;
  key: string;
  value: string;
  confidence: number;
}

/** Returns all stored memories for a given chatId. */
export async function getUserMemories(chatId: string): Promise<MemoryEntry[]> {
  try {
    const rows = await db
      .select({
        category: userMemory.category,
        key: userMemory.key,
        value: userMemory.value,
        confidence: userMemory.confidence,
      })
      .from(userMemory)
      .where(eq(userMemory.chatId, chatId));
    return rows.map((r) => ({ ...r, confidence: r.confidence ?? 1 }));
  } catch (e) {
    logger.error({ err: e, chatId }, "getUserMemories failed");
    return [];
  }
}

/** Formats memories as a system-prompt suffix for Claude. */
export function formatMemoriesForPrompt(memories: MemoryEntry[]): string {
  if (!memories.length) return "";
  const lines = memories.map(
    (m) => `- [${m.category}] ${m.key}: ${m.value}${m.confidence >= 2 ? " (confermato piu volte)" : ""}`,
  );
  return `\nPREFERENZE UTENTE (apprese dalle conversazioni passate):\n${lines.join("\n")}\n- Se una preferenza e' contrassegnata come "confermato piu volte", suggeriscila proattivamente (es. "Lo preferisci in Word come le altre volte?").\n- Per le preferenze non ancora consolidate, applicale silenziosamente senza chiedere conferma.`;
}

/** Uses claude-haiku to extract preferences/patterns and upserts them into DB. */
export async function extractAndSaveMemories(chatId: string, query: string, response: string): Promise<void> {
  // Skip trivial exchanges
  if ((query + response).length < 80) return;

  try {
    const result = await extractor.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: `Analizza questa coppia utente/assistente ed estrai eventuali preferenze o pattern dell'utente.
Rispondi SOLO con un JSON array valido (o [] se non c'e' nulla di rilevante da estrarre).
Formato: [{"category": "preference"|"pattern"|"context", "key": "chiave_breve_snake_case", "value": "valore"}]

Esempi validi da estrarre:
- Formato file preferito: {"category":"preference","key":"report_format","value":"word"}
- Assegnatario ricorrente: {"category":"preference","key":"preferred_assignee","value":"Damiano"}
- Orario preferito meeting: {"category":"preference","key":"meeting_time","value":"mattina"}
- Progetto ricorrente: {"category":"context","key":"active_project","value":"lancio prodotto Q2"}

NON estrarre: fatti banali, info gia' nel sistema, richieste chiaramente one-time, saluti.`,
      messages: [{ role: "user", content: `Utente: ${query}\n\nAssistente: ${response}` }],
    });

    const rawText = result.content.find((b) => b.type === "text")?.text ?? "[]";
    // Strip markdown code fences if Haiku wraps the JSON
    const raw = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    let extracted: Array<{ category: string; key: string; value: string }>;
    try {
      extracted = JSON.parse(raw);
    } catch {
      logger.warn({ raw, chatId }, "Memory extraction: invalid JSON from haiku");
      return;
    }

    if (!Array.isArray(extracted) || !extracted.length) return;

    for (const mem of extracted) {
      if (!mem.category || !mem.key || !mem.value) continue;
      await db
        .insert(userMemory)
        .values({
          chatId,
          category: mem.category,
          key: mem.key,
          value: mem.value,
          confidence: 1,
        })
        .onConflictDoUpdate({
          target: [userMemory.chatId, userMemory.category, userMemory.key],
          set: {
            value: mem.value,
            confidence: sql`${userMemory.confidence} + 1`,
            lastUsed: new Date(),
          },
        });
    }

    logger.debug({ chatId, count: extracted.length }, "User memories saved");
  } catch (e) {
    logger.error({ err: e, chatId }, "extractAndSaveMemories failed");
  }
}

/**
 * Decay confidence of stale user memories and delete abandoned ones.
 * Called from weekly cleanupOldData() — no new cron job needed.
 */
export async function decayStaleMemories(): Promise<void> {
  try {
    const DAY = 24 * 60 * 60 * 1000;
    const sixtyDaysAgo = new Date(Date.now() - 60 * DAY);
    const ninetyDaysAgo = new Date(Date.now() - 90 * DAY);

    // Decrement confidence for memories not used in 60+ days (only if confidence > 1)
    await db.update(userMemory)
      .set({ confidence: sql`${userMemory.confidence} - 1` })
      .where(and(
        lt(userMemory.lastUsed, sixtyDaysAgo),
        sql`${userMemory.confidence} > 1`,
      ));

    // Delete memories with confidence <= 0 that haven't been used in 90+ days
    await db.delete(userMemory)
      .where(and(
        lt(userMemory.lastUsed, ninetyDaysAgo),
        sql`${userMemory.confidence} <= 0`,
      ));

    logger.debug("Stale user memories decayed");
  } catch (e) {
    logger.error({ err: e }, "decayStaleMemories failed");
  }
}
