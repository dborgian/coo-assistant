/**
 * Conversation context compression service.
 *
 * Before each Claude API call, estimates the total token count of the payload.
 * If it exceeds the compression threshold (~40% of the 200k context window),
 * uses claude-haiku-4-5 to summarise older conversation entries, stores the
 * summary in the DB, and returns a trimmed messages array.
 *
 * This prevents the bot from ever approaching the context window limit.
 *
 * Thresholds:
 *   - Heuristic skip: < 55k estimated tokens → skip precise check
 *   - Compression trigger: > 80k precise tokens → compress
 *   - Messages kept after compression: last 4 entries (2 user/assistant pairs)
 */
import Anthropic from "@anthropic-ai/sdk";
import { lt, eq, sql } from "drizzle-orm";
import { db } from "../models/database.js";
import { conversationSummaries } from "../models/schema.js";
import { logger } from "../utils/logger.js";
import type { MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages.js";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const HEURISTIC_SKIP_TOKENS = 55_000;   // below this: skip the API token count
const COMPRESSION_TRIGGER_TOKENS = 80_000; // above this: compress
const MESSAGES_TO_KEEP = 4;             // keep last 4 entries after compression
const SUMMARY_MAX_TOKENS = 1_000;       // max tokens for the Haiku summary output

const compressor = new Anthropic();

// ---- Token estimation -------------------------------------------------------

/**
 * Fast heuristic: chars / 3.5 ≈ tokens (mixed Italian/English).
 * Zero latency — used as pre-filter before the precise API call.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/**
 * Precise token count via the Anthropic countTokens API.
 * Only called when the heuristic suggests we may be near the threshold.
 */
export async function countTokensPrecise(
  client: Anthropic,
  model: string,
  system: string,
  messages: MessageParam[],
  tools: Tool[],
): Promise<number> {
  try {
    const result = await client.messages.countTokens({
      model,
      system,
      messages,
      tools: tools as Parameters<typeof client.messages.countTokens>[0]["tools"],
    });
    return result.input_tokens;
  } catch (err) {
    logger.warn({ err }, "countTokens API failed, falling back to heuristic");
    // Fallback: use heuristic on the serialised payload
    return estimateTokens(system + JSON.stringify(messages) + JSON.stringify(tools));
  }
}

// ---- DB operations ----------------------------------------------------------

/** Returns the stored summary text for a chatId, or null if none. */
export async function getConversationSummary(chatId: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ summary: conversationSummaries.summary })
      .from(conversationSummaries)
      .where(eq(conversationSummaries.chatId, chatId))
      .limit(1);
    return row?.summary ?? null;
  } catch (err) {
    logger.warn({ err, chatId }, "Failed to load conversation summary");
    return null;
  }
}

// ---- Main compression logic -------------------------------------------------

/**
 * Ensures the existing DB summary (if any) is always prepended as the first message pair,
 * then checks whether the payload exceeds the compression threshold and compresses if needed.
 *
 * The summary pair is treated as a read-only context header — it is never included in what
 * gets re-summarized, so each compression cycle only processes new history entries.
 *
 * Returns { messages, compressed, tokensBefore, tokensAfter, messagesCompressed } — compressed=true if Haiku compression was triggered.
 */
export async function compressConversationIfNeeded(
  chatId: string,
  client: Anthropic,
  model: string,
  systemPrompt: string,
  messages: MessageParam[],
  tools: Tool[],
): Promise<{ messages: MessageParam[]; compressed: boolean; tokensBefore?: number; tokensAfter?: number; messagesCompressed?: number }> {
  // Load the existing summary from DB (if any) and inject it as a read-only header
  const existingSummary = await getConversationSummary(chatId);
  let baseMessages = messages;

  if (existingSummary) {
    const summaryPair: MessageParam[] = [
      { role: "user", content: `[CONTESTO CONVERSAZIONI PRECEDENTI]\n${existingSummary}` },
      { role: "assistant", content: "Ho presente il contesto delle conversazioni precedenti. Come posso aiutarti?" },
    ];
    baseMessages = [...summaryPair, ...messages];
  }

  // Fast heuristic pre-check
  const heuristicTokens = estimateTokens(
    systemPrompt + JSON.stringify(baseMessages) + JSON.stringify(tools),
  );
  if (heuristicTokens < HEURISTIC_SKIP_TOKENS) {
    return { messages: baseMessages, compressed: false };
  }

  // Precise check only when near threshold
  const preciseTokens = await countTokensPrecise(client, model, systemPrompt, baseMessages, tools);
  if (preciseTokens < COMPRESSION_TRIGGER_TOKENS) {
    return { messages: baseMessages, compressed: false, tokensBefore: preciseTokens };
  }

  logger.info({ chatId, preciseTokens }, "Context compression triggered");

  // Compress only the raw history (messages), not the summary header (baseMessages).
  // This prevents the existing summary from being re-summarized on each cycle.
  const recentMessages = messages.slice(-MESSAGES_TO_KEEP);
  const oldMessages = messages.slice(0, messages.length - MESSAGES_TO_KEEP);

  if (!oldMessages.length) {
    // Nothing to compress (all entries are recent)
    return { messages: baseMessages, compressed: false, tokensBefore: preciseTokens };
  }

  // Build the text to summarise — fold in the existing summary so context accumulates
  const textToSummarise = [
    existingSummary ? `[RIASSUNTO PRECEDENTE]\n${existingSummary}\n` : "",
    oldMessages
      .map((m) => {
        const role = m.role === "assistant" ? "Assistente" : "Utente";
        const content = typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content.filter((b) => b.type === "text").map((b) => (b as { type: "text"; text: string }).text).join(" ")
            : "";
        return `${role}: ${content}`;
      })
      .filter(Boolean)
      .join("\n"),
  ].join("\n").trim();

  // Call Haiku to compress
  let summary = "";
  try {
    const res = await compressor.messages.create({
      model: HAIKU_MODEL,
      max_tokens: SUMMARY_MAX_TOKENS,
      system:
        "Sei un compressore di contesto conversazionale. Riassumi la seguente cronologia " +
        "preservando: decisioni prese, task creati o menzionati, richieste ancora aperte, " +
        "informazioni chiave sulle persone o sui progetti. " +
        "Rispondi SOLO con il riassunto, niente preamboli. Massimo 500 parole.",
      messages: [{ role: "user", content: textToSummarise }],
    });
    const textBlock = res.content.find((b) => b.type === "text");
    summary = textBlock && textBlock.type === "text" ? textBlock.text.trim() : "";
  } catch (err) {
    logger.error({ err, chatId }, "Haiku compression call failed — skipping compression");
    return { messages: baseMessages, compressed: false, tokensBefore: preciseTokens };
  }

  if (!summary) {
    return { messages: baseMessages, compressed: false, tokensBefore: preciseTokens };
  }

  // Upsert summary in DB (one row per chatId)
  try {
    await db
      .insert(conversationSummaries)
      .values({
        chatId,
        summary,
        messageCount: oldMessages.length,
        tokenEstimate: preciseTokens,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: conversationSummaries.chatId,
        set: {
          summary,
          messageCount: oldMessages.length,
          tokenEstimate: preciseTokens,
          compressionCount: sql`conversation_summaries.compression_count + 1`,
          updatedAt: new Date(),
        },
      });
  } catch (err) {
    logger.error({ err, chatId }, "Failed to upsert conversation summary");
    // Continue — return compressed messages even if DB write failed
  }

  // Build reduced messages: summary as first turn + recent entries
  const compressedMessages: MessageParam[] = [
    { role: "user", content: `[CONTESTO CONVERSAZIONI PRECEDENTI]\n${summary}` },
    { role: "assistant", content: "Ho presente il contesto delle conversazioni precedenti. Come posso aiutarti?" },
    ...recentMessages,
  ];

  const tokensAfter = estimateTokens(systemPrompt + JSON.stringify(compressedMessages) + JSON.stringify(tools));

  logger.info(
    { chatId, from: baseMessages.length, to: compressedMessages.length, tokensBefore: preciseTokens, tokensAfter, messagesCompressed: oldMessages.length },
    "Conversation compressed successfully",
  );

  return { messages: compressedMessages, compressed: true, tokensBefore: preciseTokens, tokensAfter, messagesCompressed: oldMessages.length };
}

// ---- Cleanup ----------------------------------------------------------------

/** Deletes the summary for a specific chatId. Called when clearing a conversation. */
export async function deleteConversationSummary(chatId: string): Promise<void> {
  try {
    await db.delete(conversationSummaries).where(eq(conversationSummaries.chatId, chatId));
  } catch (err) {
    logger.warn({ err, chatId }, "Failed to delete conversation summary");
  }
}

/**
 * Deletes summaries that have not been updated in `retentionDays` days.
 * Called from the weekly cleanup job.
 */
export async function cleanupOldSummaries(retentionDays = 90): Promise<void> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  try {
    await db
      .delete(conversationSummaries)
      .where(lt(conversationSummaries.updatedAt, cutoff));
    logger.info({ retentionDays }, "Old conversation summaries cleaned up");
  } catch (err) {
    logger.error({ err }, "Failed to clean up old conversation summaries");
  }
}
