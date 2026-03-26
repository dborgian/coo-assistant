import { logger } from "./logger.js";

type SendFn = (chatId: number, message: string) => Promise<void>;

interface BatchEntry {
  message: string;
  timestamp: number;
}

const batches = new Map<string, BatchEntry[]>();
let flushTimer: NodeJS.Timeout | null = null;
let sendFunction: SendFn | null = null;
let targetChatId: number | null = null;

const BATCH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export function initBatcher(chatId: number, send: SendFn): void {
  targetChatId = chatId;
  sendFunction = send;

  if (flushTimer) clearInterval(flushTimer);
  flushTimer = setInterval(flushAll, BATCH_INTERVAL_MS);
}

/**
 * Queue a notification. Category groups related messages.
 * Messages are flushed every 5 minutes as a single digest.
 */
export function queueNotification(category: string, message: string): void {
  if (!batches.has(category)) batches.set(category, []);
  batches.get(category)!.push({ message, timestamp: Date.now() });
}

/**
 * Send a notification immediately (for critical alerts).
 */
export async function sendImmediate(message: string): Promise<void> {
  if (!sendFunction || !targetChatId) {
    logger.warn("Batcher not initialized — dropping immediate notification");
    return;
  }
  await sendFunction(targetChatId, message);
}

async function flushAll(): Promise<void> {
  if (!sendFunction || !targetChatId) return;

  const entries = new Map(batches);
  batches.clear();

  if (!entries.size) return;

  const lines: string[] = [];

  for (const [category, items] of entries) {
    if (items.length === 1) {
      lines.push(items[0].message);
    } else {
      lines.push(`${category} (${items.length}):`);
      for (const item of items) {
        lines.push(`  ${item.message}`);
      }
    }
  }

  const digest = lines.join("\n\n");

  try {
    // Split if too long
    if (digest.length > 4000) {
      for (let i = 0; i < digest.length; i += 4000) {
        await sendFunction(targetChatId, digest.slice(i, i + 4000));
      }
    } else {
      await sendFunction(targetChatId, digest);
    }
    logger.debug({ categories: entries.size }, "Notification batch flushed");
  } catch (err) {
    logger.error({ err }, "Failed to flush notification batch");
  }
}

export function stopBatcher(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  // Flush remaining
  flushAll().catch(() => {});
}
