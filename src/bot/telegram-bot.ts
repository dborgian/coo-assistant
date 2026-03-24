import { Bot } from "grammy";
import { config } from "../config.js";
import {
  addClientCommand,
  addEmployeeCommand,
  askCommand,
  helpCommand,
  monitorCommand,
  remindCommand,
  reportCommand,
  startCommand,
  statusCommand,
  tasksCommand,
} from "./commands.js";
import { logger } from "../utils/logger.js";

export function createBot(): Bot {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  // Middleware: only allow owner
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== config.TELEGRAM_OWNER_CHAT_ID) return;
    await next();
  });

  bot.command("start", startCommand);
  bot.command("help", helpCommand);
  bot.command("status", statusCommand);
  bot.command("report", reportCommand);
  bot.command("tasks", tasksCommand);
  bot.command("remind", remindCommand);
  bot.command("add_employee", addEmployeeCommand);
  bot.command("add_client", addClientCommand);
  bot.command("monitor", monitorCommand);

  // Free-form messages go to the AI agent
  bot.on("message:text", askCommand);

  // Error handler — prevents crashes on unhandled errors
  bot.catch((err) => {
    const ctx = err.ctx;
    const e = err.error;
    logger.error({ err: e, updateId: ctx.update.update_id }, "Bot error");
    ctx.reply("Something went wrong. Please try again.").catch(() => {});
  });

  logger.info({ ownerId: config.TELEGRAM_OWNER_CHAT_ID }, "Telegram bot configured");

  return bot;
}
