import { agent } from "../core/agent.js";
import { getTodayEvents } from "./calendar-sync.js";
import { db } from "../models/database.js";
import { intelligenceEvents } from "../models/schema.js";
import { getRedis } from "../utils/conversation-cache.js";
import { logger } from "../utils/logger.js";

const MEETACT_TTL = 2 * 60 * 60; // 2 hours — one suggestion per meeting per run
// In-memory fallback when Redis is unavailable
const processedMeetings = new Set<string>();

export async function checkMeetingActionItems(): Promise<void> {
  const events = await getTodayEvents().catch(() => []);
  if (!events.length) return;

  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

  // Find meetings that ended in the last hour
  const recentlyEnded = events.filter((e) => {
    const end = new Date(e.end);
    return end > oneHourAgo && end <= now;
  });

  if (!recentlyEnded.length) return;

  const redis = getRedis();

  for (const meeting of recentlyEnded) {
    const dedupKey = `meetact:${meeting.id}`;
    try {
      // Dedup: skip if this meeting was already processed in the last 2 hours
      if (redis) {
        const exists = await redis.exists(dedupKey);
        if (exists) continue;
      } else {
        if (processedMeetings.has(meeting.id)) continue;
      }

      const suggestion = await agent.think(
        `Un meeting e' appena terminato. Basandoti sul titolo e descrizione, suggerisci 1-3 action items concreti che potrebbero derivare da questo meeting. Se il titolo non suggerisce nulla di specifico, rispondi "NONE".
Rispondi SOLO con gli action items come lista, senza introduzione. Esempio:
- Inviare il recap al team
- Creare task per il follow-up con il cliente`,
        {
          meeting_title: meeting.summary,
          meeting_description: meeting.description ?? null,
          meeting_organizer: meeting.organizer ?? null,
          meeting_start: meeting.start,
          meeting_end: meeting.end,
        },
      );

      if (suggestion.trim() === "NONE" || suggestion.trim().length < 10) {
        // Mark as processed even if no suggestion, to avoid re-checking
        if (redis) await redis.set(dedupKey, "1", "EX", MEETACT_TTL).catch(() => {});
        else processedMeetings.add(meeting.id);
        continue;
      }

      // Save silently to intelligence_events — surfaced on-demand via get_meeting_intelligence tool
      await db.insert(intelligenceEvents).values({
        type: "meeting_suggestion",
        content: `${meeting.summary}: ${suggestion.slice(0, 300)}`,
        status: "open",
        metadata: {
          meetingTitle: meeting.summary,
          meetingStart: meeting.start,
          meetingEnd: meeting.end,
          suggestion,
        },
      }).catch((err) => logger.warn({ err }, "Failed to save meeting suggestion"));

      // Mark as processed
      if (redis) {
        await redis.set(dedupKey, "1", "EX", MEETACT_TTL).catch(() => {});
      } else {
        processedMeetings.add(meeting.id);
        if (processedMeetings.size > 200) processedMeetings.clear();
      }

      logger.info({ meeting: meeting.summary }, "Meeting action items saved silently");
    } catch (err) {
      logger.error({ err, meeting: meeting.summary }, "Failed to process meeting actions");
    }
  }
}
