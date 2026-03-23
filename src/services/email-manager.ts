import type { Bot } from "grammy";
import { logger } from "../utils/logger.js";

export async function checkImportantEmails(_bot: Bot): Promise<void> {
  // TODO: Integrate with Gmail MCP server
  // The flow will be:
  // 1. Call MCP tool: gmail.list_messages(query="is:unread is:important")
  // 2. For each important unread email, classify urgency via AI
  // 3. Notify owner of urgent emails
  // 4. Log to message_logs table

  logger.debug("Email check — MCP integration pending setup");
}
