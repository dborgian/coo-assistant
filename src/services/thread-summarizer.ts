import { and, eq, gte, sql } from "drizzle-orm";
import { agent } from "../core/agent.js";
import { db } from "../models/database.js";
import { messageLogs } from "../models/schema.js";
import { sendSlackMessage, getNotificationsChannel } from "../bot/slack-monitor.js";
import { logger } from "../utils/logger.js";

const THREAD_QUIET_MINUTES = 30;
const MIN_THREAD_MESSAGES = 5;

/** Track threads we've already summarized to avoid duplicates */
const summarizedThreads = new Set<string>();

/**
 * Check for Slack threads that have gone quiet and summarize them.
 * Called on a schedule (e.g., every 15 minutes).
 */
export async function checkAndSummarizeThreads(): Promise<void> {
  const cutoff = new Date(Date.now() - THREAD_QUIET_MINUTES * 60 * 1000);

  // Find threads with enough messages where the last message is old enough
  const threadCandidates = await db
    .select({
      threadTs: messageLogs.threadTs,
      channelTitle: messageLogs.chatTitle,
      msgCount: sql<number>`count(*)`,
      lastMessage: sql<Date>`max(${messageLogs.receivedAt})`,
    })
    .from(messageLogs)
    .where(
      and(
        eq(messageLogs.source, "slack"),
        sql`${messageLogs.threadTs} IS NOT NULL`,
      ),
    )
    .groupBy(messageLogs.threadTs, messageLogs.chatTitle)
    .having(
      and(
        sql`count(*) >= ${MIN_THREAD_MESSAGES}`,
        sql`max(${messageLogs.receivedAt}) < ${cutoff}`,
        // Only threads from the last 24 hours
        sql`max(${messageLogs.receivedAt}) > now() - interval '24 hours'`,
      ),
    );

  for (const thread of threadCandidates) {
    if (!thread.threadTs || summarizedThreads.has(thread.threadTs)) continue;

    try {
      await summarizeThread(thread.threadTs, thread.channelTitle ?? "unknown");
      summarizedThreads.add(thread.threadTs);
    } catch (err) {
      logger.error({ err, threadTs: thread.threadTs }, "Thread summarization failed");
    }
  }

  // Clean up old entries from the set (keep last 500)
  if (summarizedThreads.size > 500) {
    const entries = [...summarizedThreads];
    entries.slice(0, entries.length - 500).forEach((t) => summarizedThreads.delete(t));
  }
}

async function summarizeThread(threadTs: string, channelTitle: string): Promise<void> {
  const messages = await db
    .select({
      senderName: messageLogs.senderName,
      content: messageLogs.fullContent,
      shortContent: messageLogs.content,
      receivedAt: messageLogs.receivedAt,
    })
    .from(messageLogs)
    .where(
      and(
        eq(messageLogs.source, "slack"),
        eq(messageLogs.threadTs, threadTs),
      ),
    )
    .orderBy(messageLogs.receivedAt);

  if (messages.length < MIN_THREAD_MESSAGES) return;

  const transcript = messages
    .map((m) => `${m.senderName}: ${m.content ?? m.shortContent}`)
    .join("\n");

  const summary = await agent.think(
    `Analizza questa conversazione Slack e genera un breve riassunto strutturato. Rispondi in italiano, max 500 caratteri. Includi: decisioni prese, action item (chi deve fare cosa), e domande aperte rimaste.`,
    { channel: channelTitle, messages: transcript.slice(0, 3000) },
  );

  if (!summary || summary.trim().length < 20) return;

  // Find the channel ID from the chatTitle (strip #)
  const channelName = channelTitle.replace(/^#/, "");

  // Post summary — we need the channel ID, not name
  // For now post to notifications channel as we don't store channel IDs in messageLogs reliably
  const notifCh = getNotificationsChannel();
  if (notifCh) {
    await sendSlackMessage(
      notifCh,
      `\uD83D\uDCDD Thread Summary — ${channelTitle}\n\n${summary}`,
    );
  }

  logger.info({ threadTs, channel: channelTitle, messageCount: messages.length }, "Thread summarized");
}

/**
 * Generate end-of-day digest for monitored Slack channels.
 * Summarizes the day's conversations per channel.
 */
export async function generateDailySlackDigest(): Promise<void> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const channelMessages = await db
    .select({
      chatTitle: messageLogs.chatTitle,
      msgCount: sql<number>`count(*)`,
    })
    .from(messageLogs)
    .where(
      and(
        eq(messageLogs.source, "slack"),
        gte(messageLogs.receivedAt, today),
      ),
    )
    .groupBy(messageLogs.chatTitle)
    .having(sql`count(*) >= 3`);

  if (!channelMessages.length) return;

  for (const ch of channelMessages) {
    if (!ch.chatTitle) continue;

    const msgs = await db
      .select({
        senderName: messageLogs.senderName,
        content: messageLogs.fullContent,
        shortContent: messageLogs.content,
      })
      .from(messageLogs)
      .where(
        and(
          eq(messageLogs.source, "slack"),
          eq(messageLogs.chatTitle, ch.chatTitle),
          gte(messageLogs.receivedAt, today),
        ),
      )
      .orderBy(messageLogs.receivedAt);

    const transcript = msgs
      .map((m) => `${m.senderName}: ${m.content ?? m.shortContent}`)
      .join("\n");

    const summary = await agent.think(
      `Genera un digest giornaliero delle conversazioni in questo canale Slack. Evidenzia: argomenti principali, decisioni, action item, problemi emersi. Max 600 caratteri, in italiano.`,
      { channel: ch.chatTitle, message_count: ch.msgCount, messages: transcript.slice(0, 4000) },
    );

    if (summary && summary.trim().length > 20) {
      const digestCh = getNotificationsChannel();
      if (digestCh) {
        await sendSlackMessage(
          digestCh,
          `\uD83D\uDCCA Digest ${ch.chatTitle} — ${new Date().toLocaleDateString("it-IT")}\n\n${summary}`,
        );
      }
    }
  }

  logger.info({ channels: channelMessages.length }, "Daily Slack digest generated");
}
