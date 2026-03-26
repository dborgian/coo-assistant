import type { Bot } from "grammy";
import { agent } from "../core/agent.js";
import { config } from "../config.js";
import { getTodayEvents } from "./calendar-sync.js";
import { logger } from "../utils/logger.js";

export async function checkMeetingActionItems(bot: Bot): Promise<void> {
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

  for (const meeting of recentlyEnded) {
    try {
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

      if (suggestion.trim() === "NONE" || suggestion.trim().length < 10) continue;

      await bot.api.sendMessage(
        config.TELEGRAM_OWNER_CHAT_ID,
        `\uD83D\uDCCB Meeting terminato: "${meeting.summary}"\n\nAction items suggeriti:\n${suggestion}\n\nVuoi che crei dei task? Scrivi ad esempio: "crea task follow-up meeting ${meeting.summary}"`,
      );

      logger.info({ meeting: meeting.summary }, "Meeting action items suggested");
    } catch (err) {
      logger.error({ err, meeting: meeting.summary }, "Failed to suggest meeting actions");
    }
  }
}
