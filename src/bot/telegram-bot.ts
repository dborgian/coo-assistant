import { Bot } from "grammy";
import { config } from "../config.js";
import {
  addClientCommand,
  addEmployeeCommand,
  askCommand,
  dashboardCommand,
  driveCommand,
  employeeReportCommand,
  helpCommand,
  monitorCommand,
  notionCommand,
  remindCommand,
  reportPdfCommand,
  reportsCommand,
  slackCommand,
  slackReportCommand,
  slackSummaryCommand,
  reportCommand,
  startCommand,
  statusCommand,
  tasksCommand,
} from "./commands.js";
import { registerCallbacks } from "./callbacks.js";
import { authMiddleware, requireRole } from "./auth.js";
import { handleOAuthCode, handleConnectGoogle, handleConnectGoogleCode } from "./onboarding.js";
import { logger } from "../utils/logger.js";

export function createBot(): Bot {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  // Set command menu for Telegram autocomplete
  bot.api.setMyCommands([
    { command: "dashboard", description: "Interactive dashboard" },
    { command: "status", description: "Quick operations overview" },
    { command: "report", description: "Generate operations report" },
    { command: "report_pdf", description: "Generate PDF report (daily/weekly)" },
    { command: "employee_report", description: "Employee activity report (PDF)" },
    { command: "drive", description: "COO Drive files" },
    { command: "reports", description: "View report history" },
    { command: "tasks", description: "View active tasks" },
    { command: "notion", description: "Notion workspace summary" },
    { command: "slack_report", description: "Slack digest (24h)" },
    { command: "slack_summary", description: "AI Slack summary" },
    { command: "remind", description: "Set a reminder" },
    { command: "add_employee", description: "Add team member" },
    { command: "add_client", description: "Add client" },
    { command: "monitor", description: "Configure Telegram monitoring" },
    { command: "slack", description: "Configure Slack monitoring" },
    { command: "connect_google", description: "Connect/reconnect Google account" },
    { command: "help", description: "Show all commands" },
  ]).catch((err) => logger.warn({ err }, "Failed to set bot commands menu"));

  // Middleware: authenticate users via employees table + TELEGRAM_OWNER_CHAT_ID
  bot.use(authMiddleware);

  // Commands available to all authenticated users (owner, admin, viewer)
  bot.command("start", startCommand);
  bot.command("help", helpCommand);
  bot.command("dashboard", dashboardCommand);
  bot.command("status", statusCommand);
  bot.command("tasks", tasksCommand);

  // Commands for owner + admin only
  const adminGuard = requireRole("owner", "admin");
  bot.command("notion", adminGuard, notionCommand);
  bot.command("drive", adminGuard, driveCommand);
  bot.command("report", adminGuard, reportCommand);
  bot.command("report_pdf", adminGuard, reportPdfCommand);
  bot.command("employee_report", adminGuard, employeeReportCommand);
  bot.command("reports", adminGuard, reportsCommand);
  bot.command("slack_report", adminGuard, slackReportCommand);
  bot.command("slack_summary", adminGuard, slackSummaryCommand);
  bot.command("remind", adminGuard, remindCommand);

  // Google OAuth connect/reconnect (any authenticated user)
  bot.command("connect_google", handleConnectGoogle);

  // Commands for owner only
  const ownerGuard = requireRole("owner");
  bot.command("add_employee", ownerGuard, addEmployeeCommand);
  bot.command("add_client", ownerGuard, addClientCommand);
  bot.command("monitor", ownerGuard, monitorCommand);
  bot.command("slack", ownerGuard, slackCommand);

  // Register inline keyboard callback handlers
  registerCallbacks(bot);

  // Free-form messages: check for OAuth code first, then AI agent
  bot.on("message:text", async (ctx, next) => {
    // Check if user is in onboarding (pasting OAuth code)
    const telegramId = ctx.from?.id;
    if (telegramId) {
      const handled = await handleOAuthCode(ctx) || await handleConnectGoogleCode(ctx);
      if (handled) return;
    }
    await askCommand(ctx);
  });

  // Error handler — prevents crashes on unhandled errors
  bot.catch((err) => {
    const ctx = err.ctx;
    const e = err.error;
    logger.error({ err: e, updateId: ctx.update.update_id }, "Bot error");
    ctx.reply("Something went wrong. Please try again.").catch(() => {});
  });

  logger.info({ ownerId: config.TELEGRAM_OWNER_CHAT_ID }, "Telegram bot configured (multi-user auth enabled)");

  return bot;
}
