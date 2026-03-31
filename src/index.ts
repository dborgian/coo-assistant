import { createServer } from "node:http";
import { disconnectRedis } from "./utils/conversation-cache.js";
import { mcpManager } from "./core/mcp-client.js";
import { setupSchedules, stopSchedules } from "./core/scheduler.js";
import { initDb, closeDb } from "./models/database.js";
import { checkUpcomingEvents, registerCalendarWatch } from "./services/calendar-sync.js";
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
import { rebuildBrainFromDB, cleanupOldIntelligenceEvents } from "./services/company-brain.js";
import { startSlackMonitor, stopSlackMonitor } from "./bot/slack-monitor.js";
import { handleOAuthCallback } from "./bot/onboarding.js";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";

async function main(): Promise<void> {
  logger.info("Starting COO Assistant...");

  // Initialize database (Supabase)
  await initDb();

  // Load MCP config
  mcpManager.loadConfig();

  // Setup scheduled jobs
  setupSchedules({
    dailyReport: () => generateAndSendDailyReport(),
    chatMonitor: () => checkPendingMessages(),
    calendarCheck: () => checkUpcomingEvents(),
    emailCheck: () => checkImportantEmails(),
    taskReminders: () => checkAndSendReminders(),
    notionSync: () => syncNotionData(),
    escalationCheck: () => runEscalationCheck(),
    autoPrioritization: () => runAutoPrioritization(),
    recurringTasks: () => generateRecurringTasks(),
    workloadMetrics: () => updateWorkloadMetrics(),
    staleDetection: () => detectStaleTasks(),
    autoScheduling: () => autoScheduleTasks(),
    smartAgenda: () => generateAndSendAgendas(),
    proactiveCheck: () => runProactiveCheck(),
    weeklyDigest: () => generateWeeklyDigest(),
    meetingActions: () => checkMeetingActionItems(),
    clientUpdates: () => sendWeeklyClientUpdates(),
    notionTwoWaySync: async () => { await syncTasksToNotion().catch((e) => logger.error({ err: e }, "syncTasksToNotion failed")); await syncNotionToTasks().catch((e) => logger.error({ err: e }, "syncNotionToTasks failed")); },
    sheetsExport: () => exportWeeklyMetrics(),
    intelligenceBatch: async () => { await analyzeSentimentBatch(); await extractKnowledgeBatch(); },
    communicationStatsJob: () => updateCommunicationStats(),
    sentimentAlerts: () => checkSentimentAlerts(),
    commitmentCheck: () => checkCommitmentFulfillment(),
    silentEmployeeCheck: () => detectSilentEmployees(),
    meetingOverload: () => detectMeetingOverload(),
    topicExtraction: async () => { await extractDailyTopics(); },
    threadSummarizer: async () => { await checkAndSummarizeThreads(); },
    dailySlackDigest: async () => { await generateDailySlackDigest(); },
    eodPrompts: async () => { await sendEodPrompts(); },
    eodCollect: async () => { await collectEodResponses(); },
    meetingNotes: async () => { await checkRecentMeetings(); },
    calendarWatchRenewal: () => registerCalendarWatch(),
    brainCleanup: () => cleanupOldIntelligenceEvents(),
  });

  // Discover and link Notion users to employees
  discoverNotionUsers().catch((err) => logger.warn({ err }, "Notion user discovery failed at startup"));

  // Rebuild Company Brain from PostgreSQL if Redis is empty (cold start / Redis reset)
  rebuildBrainFromDB().catch((err) => logger.warn({ err }, "Brain rebuild from DB failed at startup"));

  // Register Google Calendar push notification watch (near-real-time meeting detection)
  registerCalendarWatch().catch((err) => logger.warn({ err }, "Calendar watch registration failed at startup"));

  // Start Slack monitor (handles all bot interactions, slash commands, and channel monitoring)
  const slackStarted = await startSlackMonitor();
  if (slackStarted) {
    logger.info("Slack monitoring active");
  }

  // HTTP server: health check + OAuth callback
  const port = process.env.PORT || 3000;
  let lastWebhookCheck = 0; // debounce: ignore rapid repeated calendar notifications
  createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);

    // Google Calendar push notification webhook
    if (url.pathname === "/webhooks/calendar" && req.method === "POST") {
      const token = req.headers["x-goog-channel-token"];
      const state = req.headers["x-goog-resource-state"];

      // Consume body (required to keep connection clean)
      req.resume();

      if (config.CALENDAR_WEBHOOK_TOKEN && token !== config.CALENDAR_WEBHOOK_TOKEN) {
        res.writeHead(403);
        res.end();
        return;
      }

      res.writeHead(200);
      res.end();

      // "sync" is the initial handshake — skip processing
      if (state === "sync") return;

      // Debounce: skip if we ran a check less than 2 minutes ago
      const now = Date.now();
      if (now - lastWebhookCheck < 120_000) {
        logger.debug("Calendar webhook debounced — too soon since last check");
        return;
      }
      lastWebhookCheck = now;

      // "exists" means calendar was modified — check for new meeting notes
      logger.info({ state }, "Calendar push notification received");
      checkRecentMeetings().catch((err) =>
        logger.error({ err }, "checkRecentMeetings triggered by webhook failed"),
      );
      return;
    }

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
        res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h1>Parametri mancanti</h1><p>Riprova da Slack.</p></body></html>`);
        return;
      }

      const result = await handleOAuthCallback(code, state);
      const status = result.ok ? 200 : 400;
      const icon = result.ok ? "&#10004;" : "&#10008;";
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h1>${icon} ${result.message}</h1><p>Puoi chiudere questa pagina e tornare a Slack.</p></body></html>`);
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
    await disconnectRedis();
    await closeDb();
    logger.info("COO Assistant stopped.");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  logger.info("COO Assistant is online.");
}

main().catch((err) => {
  logger.fatal({ err }, "Fatal error");
  process.exit(1);
});
