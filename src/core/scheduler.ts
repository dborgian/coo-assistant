import cron from "node-cron";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

type JobCallback = () => Promise<void>;

interface ScheduledJobs {
  dailyReport?: cron.ScheduledTask;
  chatMonitor?: cron.ScheduledTask;
  calendarCheck?: cron.ScheduledTask;
  emailCheck?: cron.ScheduledTask;
  taskReminders?: cron.ScheduledTask;
  notionSync?: cron.ScheduledTask;
  escalationCheck?: cron.ScheduledTask;
  autoPrioritization?: cron.ScheduledTask;
  recurringTasks?: cron.ScheduledTask;
  workloadMetrics?: cron.ScheduledTask;
  staleDetection?: cron.ScheduledTask;
  autoScheduling?: cron.ScheduledTask;
  smartAgenda?: cron.ScheduledTask;
  proactiveCheck?: cron.ScheduledTask;
  weeklyDigest?: cron.ScheduledTask;
  meetingActions?: cron.ScheduledTask;
  clientUpdates?: cron.ScheduledTask;
  notionTwoWaySync?: cron.ScheduledTask;
  sheetsExport?: cron.ScheduledTask;
  intelligenceBatch?: cron.ScheduledTask;
  communicationStatsJob?: cron.ScheduledTask;
  sentimentAlerts?: cron.ScheduledTask;
  commitmentCheck?: cron.ScheduledTask;
  silentEmployeeCheck?: cron.ScheduledTask;
  meetingOverload?: cron.ScheduledTask;
  topicExtraction?: cron.ScheduledTask;
  threadSummarizer?: cron.ScheduledTask;
  dailySlackDigest?: cron.ScheduledTask;
  eodPrompts?: cron.ScheduledTask;
  eodCollect?: cron.ScheduledTask;
  meetingNotes?: cron.ScheduledTask;
}

const jobs: ScheduledJobs = {};

export function setupSchedules(callbacks: {
  dailyReport: JobCallback;
  chatMonitor: JobCallback;
  calendarCheck: JobCallback;
  emailCheck: JobCallback;
  taskReminders: JobCallback;
  notionSync: JobCallback;
  escalationCheck: JobCallback;
  autoPrioritization: JobCallback;
  recurringTasks: JobCallback;
  workloadMetrics: JobCallback;
  staleDetection: JobCallback;
  autoScheduling: JobCallback;
  smartAgenda: JobCallback;
  proactiveCheck: JobCallback;
  weeklyDigest: JobCallback;
  meetingActions: JobCallback;
  clientUpdates: JobCallback;
  notionTwoWaySync: JobCallback;
  sheetsExport: JobCallback;
  intelligenceBatch: JobCallback;
  communicationStatsJob: JobCallback;
  sentimentAlerts: JobCallback;
  commitmentCheck: JobCallback;
  silentEmployeeCheck: JobCallback;
  meetingOverload: JobCallback;
  topicExtraction: JobCallback;
  threadSummarizer: JobCallback;
  dailySlackDigest: JobCallback;
  eodPrompts: JobCallback;
  eodCollect: JobCallback;
  meetingNotes: JobCallback;
}): void {
  // Daily operations report
  const { DAILY_REPORT_HOUR: h, DAILY_REPORT_MINUTE: m, TIMEZONE: tz } = config;
  jobs.dailyReport = cron.schedule(`${m} ${h} * * *`, () => {
    callbacks.dailyReport().catch((err) =>
      logger.error({ err }, "Daily report failed"),
    );
  }, { timezone: tz });

  // Chat monitoring (every N minutes)
  jobs.chatMonitor = cron.schedule(`*/${config.CHAT_CHECK_INTERVAL_MINUTES} * * * *`, () => {
    callbacks.chatMonitor().catch((err) =>
      logger.error({ err }, "Chat monitor failed"),
    );
  });

  // Calendar conflict check (every N minutes)
  jobs.calendarCheck = cron.schedule(`*/${config.CALENDAR_CHECK_INTERVAL_MINUTES} * * * *`, () => {
    callbacks.calendarCheck().catch((err) =>
      logger.error({ err }, "Calendar check failed"),
    );
  });

  // Email check (every N minutes)
  jobs.emailCheck = cron.schedule(`*/${config.EMAIL_CHECK_INTERVAL_MINUTES} * * * *`, () => {
    callbacks.emailCheck().catch((err) =>
      logger.error({ err }, "Email check failed"),
    );
  });

  // Task reminder check (every 10 minutes)
  jobs.taskReminders = cron.schedule("*/10 * * * *", () => {
    callbacks.taskReminders().catch((err) =>
      logger.error({ err }, "Task reminders failed"),
    );
  });

  // Notion sync (every N minutes)
  jobs.notionSync = cron.schedule(`*/${config.NOTION_SYNC_INTERVAL_MINUTES} * * * *`, () => {
    callbacks.notionSync().catch((err) =>
      logger.error({ err }, "Notion sync failed"),
    );
  });

  // Escalation check (every 30 minutes)
  jobs.escalationCheck = cron.schedule("*/30 * * * *", () => {
    callbacks.escalationCheck().catch((err) =>
      logger.error({ err }, "Escalation check failed"),
    );
  });

  // Auto-prioritization (every 2 hours)
  jobs.autoPrioritization = cron.schedule("0 */2 * * *", () => {
    callbacks.autoPrioritization().catch((err) =>
      logger.error({ err }, "Auto-prioritization failed"),
    );
  });

  // Recurring task generation (daily at 00:05)
  jobs.recurringTasks = cron.schedule("5 0 * * *", () => {
    callbacks.recurringTasks().catch((err) =>
      logger.error({ err }, "Recurring tasks generation failed"),
    );
  }, { timezone: tz });

  // Workload metrics (daily at 23:30)
  jobs.workloadMetrics = cron.schedule("30 23 * * *", () => {
    callbacks.workloadMetrics().catch((err) =>
      logger.error({ err }, "Workload metrics failed"),
    );
  }, { timezone: tz });

  // Stale task detection (daily at 09:00)
  jobs.staleDetection = cron.schedule("0 9 * * *", () => {
    callbacks.staleDetection().catch((err) =>
      logger.error({ err }, "Stale detection failed"),
    );
  }, { timezone: tz });

  // Auto-scheduling (every 4 hours)
  jobs.autoScheduling = cron.schedule("0 */4 * * *", () => {
    callbacks.autoScheduling().catch((err) =>
      logger.error({ err }, "Auto-scheduling failed"),
    );
  });

  // Smart daily agenda (daily at 07:30)
  jobs.smartAgenda = cron.schedule("30 7 * * *", () => {
    callbacks.smartAgenda().catch((err) =>
      logger.error({ err }, "Smart agenda failed"),
    );
  }, { timezone: tz });

  // Proactive AI check (twice daily: 11:00 and 16:00)
  jobs.proactiveCheck = cron.schedule("0 11,16 * * *", () => {
    callbacks.proactiveCheck().catch((err) =>
      logger.error({ err }, "Proactive check failed"),
    );
  }, { timezone: tz });

  // Weekly digest (Friday at 17:00)
  jobs.weeklyDigest = cron.schedule("0 17 * * 5", () => {
    callbacks.weeklyDigest().catch((err) =>
      logger.error({ err }, "Weekly digest failed"),
    );
  }, { timezone: tz });

  // Meeting action items (every 30 min, checks for recently ended meetings)
  jobs.meetingActions = cron.schedule("*/30 * * * *", () => {
    callbacks.meetingActions().catch((err) =>
      logger.error({ err }, "Meeting actions check failed"),
    );
  });

  // Weekly client status updates (Monday at 09:00)
  jobs.clientUpdates = cron.schedule("0 9 * * 1", () => {
    callbacks.clientUpdates().catch((err) =>
      logger.error({ err }, "Client updates failed"),
    );
  }, { timezone: tz });

  // Notion two-way sync (every 5 minutes)
  jobs.notionTwoWaySync = cron.schedule("*/5 * * * *", () => {
    callbacks.notionTwoWaySync().catch((err) =>
      logger.error({ err }, "Notion two-way sync failed"),
    );
  });

  // Google Sheets dashboard export (weekly, Monday at 08:00)
  jobs.sheetsExport = cron.schedule("0 8 * * 1", () => {
    callbacks.sheetsExport().catch((err) =>
      logger.error({ err }, "Sheets export failed"),
    );
  }, { timezone: tz });

  // Intelligence batch (every 4 hours — sentiment, knowledge, topics)
  jobs.intelligenceBatch = cron.schedule("0 */4 * * *", () => {
    callbacks.intelligenceBatch().catch((err) =>
      logger.error({ err }, "Intelligence batch failed"),
    );
  });

  // Communication stats (daily at 23:45)
  jobs.communicationStatsJob = cron.schedule("45 23 * * *", () => {
    callbacks.communicationStatsJob().catch((err) =>
      logger.error({ err }, "Communication stats failed"),
    );
  }, { timezone: tz });

  // Sentiment alerts (daily at 18:00)
  jobs.sentimentAlerts = cron.schedule("0 18 * * *", () => {
    callbacks.sentimentAlerts().catch((err) =>
      logger.error({ err }, "Sentiment alerts failed"),
    );
  }, { timezone: tz });

  // Commitment fulfillment check (daily at 10:00)
  jobs.commitmentCheck = cron.schedule("0 10 * * *", () => {
    callbacks.commitmentCheck().catch((err) =>
      logger.error({ err }, "Commitment check failed"),
    );
  }, { timezone: tz });

  // Silent employee detection (daily at 10:30)
  jobs.silentEmployeeCheck = cron.schedule("30 10 * * *", () => {
    callbacks.silentEmployeeCheck().catch((err) =>
      logger.error({ err }, "Silent employee check failed"),
    );
  }, { timezone: tz });

  // Meeting overload detection (daily at 08:00)
  jobs.meetingOverload = cron.schedule("0 8 * * *", () => {
    callbacks.meetingOverload().catch((err) =>
      logger.error({ err }, "Meeting overload check failed"),
    );
  }, { timezone: tz });

  // Topic extraction (daily at 23:00)
  jobs.topicExtraction = cron.schedule("0 23 * * *", () => {
    callbacks.topicExtraction().catch((err) =>
      logger.error({ err }, "Topic extraction failed"),
    );
  }, { timezone: tz });

  // Thread summarizer (every 15 min — check for quiet threads)
  jobs.threadSummarizer = cron.schedule("*/15 * * * *", () => {
    callbacks.threadSummarizer().catch((err) =>
      logger.error({ err }, "Thread summarizer failed"),
    );
  });

  // Daily Slack channel digest (18:00)
  jobs.dailySlackDigest = cron.schedule("0 18 * * *", () => {
    callbacks.dailySlackDigest().catch((err) =>
      logger.error({ err }, "Daily Slack digest failed"),
    );
  }, { timezone: tz });

  // EOD prompts (17:30) and collection (18:30)
  jobs.eodPrompts = cron.schedule("30 17 * * 1-5", () => {
    callbacks.eodPrompts().catch((err) =>
      logger.error({ err }, "EOD prompts failed"),
    );
  }, { timezone: tz });

  jobs.eodCollect = cron.schedule("30 18 * * 1-5", () => {
    callbacks.eodCollect().catch((err) =>
      logger.error({ err }, "EOD collection failed"),
    );
  }, { timezone: tz });

  // Meeting notes (every 30 min during work hours)
  jobs.meetingNotes = cron.schedule("*/30 8-19 * * 1-5", () => {
    callbacks.meetingNotes().catch((err) =>
      logger.error({ err }, "Meeting notes check failed"),
    );
  }, { timezone: tz });

  logger.info("Scheduler started");
}

export function stopSchedules(): void {
  for (const job of Object.values(jobs)) {
    job?.stop();
  }
  logger.info("Scheduler stopped");
}
