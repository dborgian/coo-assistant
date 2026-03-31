import { createServer } from "node:http";
import { disconnectRedis } from "./utils/conversation-cache.js";
import { createBot } from "./bot/telegram-bot.js";
import { mcpManager } from "./core/mcp-client.js";
import { setupSchedules, stopSchedules } from "./core/scheduler.js";
import { initDb, closeDb } from "./models/database.js";
import { checkUpcomingEvents } from "./services/calendar-sync.js";
import { checkPendingMessages } from "./services/chat-monitor.js";
import { generateAndSendDailyReport } from "./services/daily-reporter.js";
import { checkImportantEmails } from "./services/email-manager.js";
import { checkAndSendReminders } from "./services/task-reminder.js";
import { syncNotionData, discoverNotionUsers } from "./services/notion-sync.js";
import { runEscalationCheck } from "./services/task-escalation.js";
import { runAutoPrioritization } from "./services/auto-prioritizer.js";
import { generateRecurringTasks } from "./services/recurring-tasks.js";
import { updateWorkloadMetrics } from "./services/workload-tracker.js";
import { detectStaleTasks } from "./services/stale-detector.js";
import { autoScheduleTasks } from "./services/auto-scheduler.js";
import { generateAndSendAgendas } from "./services/smart-agenda.js";
import { runProactiveCheck, generateWeeklyDigest } from "./services/proactive-actions.js";
import { checkMeetingActionItems } from "./services/meeting-actions.js";
import { sendWeeklyClientUpdates } from "./services/client-updates.js";
import { syncTasksToNotion, syncNotionToTasks } from "./services/notion-two-way-sync.js";
import { exportWeeklyMetrics } from "./services/sheets-dashboard.js";
import { analyzeSentimentBatch, checkSentimentAlerts } from "./services/sentiment-analyzer.js";
import { updateCommunicationStats, detectSilentEmployees } from "./services/communication-patterns.js";
import { checkCommitmentFulfillment } from "./services/commitment-tracker.js";
import { extractKnowledgeBatch } from "./services/knowledge-base.js";
import { extractDailyTopics } from "./services/topic-analyzer.js";
import { detectMeetingOverload } from "./services/meeting-intelligence.js";
import { checkAndSummarizeThreads, generateDailySlackDigest } from "./services/thread-summarizer.js";
import { sendEodPrompts, collectEodResponses } from "./services/eod-reports.js";
import { checkRecentMeetings } from "./services/meeting-notes.js";
import { startUserbot, stopUserbot } from "./bot/monitors.js";
import { startSlackMonitor, stopSlackMonitor } from "./bot/slack-monitor.js";
import { handleOAuthCallback } from "./bot/onboarding.js";
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
    escalationCheck: () => runEscalationCheck(bot),
    autoPrioritization: () => runAutoPrioritization(bot),
    recurringTasks: () => generateRecurringTasks(bot),
    workloadMetrics: () => updateWorkloadMetrics(),
    staleDetection: () => detectStaleTasks(bot),
    autoScheduling: () => autoScheduleTasks(bot),
    smartAgenda: () => generateAndSendAgendas(bot),
    proactiveCheck: () => runProactiveCheck(bot),
    weeklyDigest: () => generateWeeklyDigest(bot),
    meetingActions: () => checkMeetingActionItems(bot),
    clientUpdates: () => sendWeeklyClientUpdates(bot),
    notionTwoWaySync: async () => { await syncTasksToNotion(bot).catch((e) => logger.error({ err: e }, "syncTasksToNotion failed")); await syncNotionToTasks(bot).catch((e) => logger.error({ err: e }, "syncNotionToTasks failed")); },
    sheetsExport: () => exportWeeklyMetrics(bot),
    intelligenceBatch: async () => { await analyzeSentimentBatch(bot); await extractKnowledgeBatch(); },
    communicationStatsJob: () => updateCommunicationStats(),
    sentimentAlerts: () => checkSentimentAlerts(bot),
    commitmentCheck: () => checkCommitmentFulfillment(bot),
    silentEmployeeCheck: () => detectSilentEmployees(bot),
    meetingOverload: () => detectMeetingOverload(bot),
    topicExtraction: async () => { await extractDailyTopics(); },
    threadSummarizer: async () => { await checkAndSummarizeThreads(); },
    dailySlackDigest: async () => { await generateDailySlackDigest(); },
    eodPrompts: async () => { await sendEodPrompts(); },
    eodCollect: async () => { await collectEodResponses(bot); },
    meetingNotes: async () => { await checkRecentMeetings(); },
  });

  // Discover and link Notion users to employees
  discoverNotionUsers().catch((err) => logger.warn({ err }, "Notion user discovery failed at startup"));

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

  // HTTP server: health check + OAuth callback
  const port = process.env.PORT || 3000;
  createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);

    if (url.pathname === "/oauth/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h1>Autorizzazione annullata</h1><p>${error}</p><p>Puoi chiudere questa pagina.</p></body></html>`);
        return;
      }

      if (!code || !state) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h1>Parametri mancanti</h1><p>Riprova dal bot Telegram.</p></body></html>`);
        return;
      }

      const result = await handleOAuthCallback(code, state, bot);
      const status = result.ok ? 200 : 400;
      const icon = result.ok ? "&#10004;" : "&#10008;";
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h1>${icon} ${result.message}</h1><p>Puoi chiudere questa pagina e tornare a Telegram.</p></body></html>`);
      return;
    }

    // Health check
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  }).listen(Number(port), () => {
    logger.info({ port }, "HTTP server listening (health + OAuth callback)");
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    stopSchedules();
    await stopSlackMonitor();
    await stopUserbot();
    await bot.stop();
    await disconnectRedis();
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
