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
}

const jobs: ScheduledJobs = {};

export function setupSchedules(callbacks: {
  dailyReport: JobCallback;
  chatMonitor: JobCallback;
  calendarCheck: JobCallback;
  emailCheck: JobCallback;
  taskReminders: JobCallback;
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

  logger.info("Scheduler started");
}

export function stopSchedules(): void {
  for (const job of Object.values(jobs)) {
    job?.stop();
  }
  logger.info("Scheduler stopped");
}
