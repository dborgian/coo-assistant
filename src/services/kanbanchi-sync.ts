import type { Bot } from "grammy";
import { logger } from "../utils/logger.js";

export async function syncKanbanchiBoard(_bot: Bot): Promise<void> {
  // TODO: Integrate with Kanbanchi API
  // The flow will be:
  // 1. Fetch all cards from the configured board
  // 2. Compare with local task DB
  // 3. Create/update local tasks from Kanbanchi cards
  // 4. Flag overdue cards
  // 5. Notify owner of any blocked or overdue items

  logger.debug("Kanbanchi sync — API integration pending setup");
}
