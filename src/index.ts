import { createBot } from "./bot/telegram-bot.js";
import { mcpManager } from "./core/mcp-client.js";
import { setupSchedules, stopSchedules } from "./core/scheduler.js";
import { initDb, closeDb } from "./models/database.js";
import { checkUpcomingEvents } from "./services/calendar-sync.js";
import { checkPendingMessages } from "./services/chat-monitor.js";
import { generateAndSendDailyReport } from "./services/daily-reporter.js";
import { checkImportantEmails } from "./services/email-manager.js";
import { checkAndSendReminders } from "./services/task-reminder.js";
import { syncNotionData } from "./services/notion-sync.js";
import { startUserbot, stopUserbot } from "./bot/monitors.js";
import { startSlackMonitor, stopSlackMonitor } from "./bot/slack-monitor.js";
import { logger } from "./utils/logger.js";

async function main(): Promise<void> {
  logger.info("Starting COO Assistant...");

  // Initialize database (Supabase)
  await initDb();

  // Load MCP config
  mcpManager.loadConfig();

  // Create Telegram bot
  const bot = createBot();

  // Setup scheduled jobs
  setupSchedules({
    dailyReport: () => generateAndSendDailyReport(bot),
    chatMonitor: () => checkPendingMessages(bot),
    calendarCheck: () => checkUpcomingEvents(bot),
    emailCheck: () => checkImportantEmails(bot),
    taskReminders: () => checkAndSendReminders(bot),
    notionSync: () => syncNotionData(bot),
  });

  // Start Telethon/GramJS userbot for chat monitoring
  const userbotStarted = await startUserbot(bot);
  if (userbotStarted) {
    logger.info("Telegram chat monitoring active");
  }

  // Start Slack monitor for channel monitoring
  const slackStarted = await startSlackMonitor(bot);
  if (slackStarted) {
    logger.info("Slack monitoring active");
  }

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    stopSchedules();
    await stopSlackMonitor();
    await stopUserbot();
    await bot.stop();
    await closeDb();
    logger.info("COO Assistant stopped.");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start the Telegram bot (blocking)
  logger.info("COO Assistant is online. Telegram bot starting...");
  await bot.start();
}

main().catch((err) => {
  logger.fatal({ err }, "Fatal error");
  process.exit(1);
});
