/**
 * Conversation history cache — two-level:
 * - Redis (if REDIS_URL is set): persistent across restarts, TTL 30 min
 * - In-memory Map (fallback): works without Redis, lost on restart
 *
 * Stores the last 5 user/assistant pairs (10 entries) per chatId.
 * Only the plain text of queries and responses is stored — not the full context JSON.
 */
import { Redis } from "ioredis";
import { config } from "../config.js";
import { logger } from "./logger.js";

const TTL_SECONDS = 1800; // 30 minutes
const MAX_ENTRIES = 10;   // 5 user/assistant pairs
const KEY_PREFIX = "conv:";

export interface ConversationEntry {
  role: "user" | "assistant";
  content: string;
}

// --- Redis client (null if not configured) ---
let redis: Redis | null = null;
if (config.REDIS_URL) {
  redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
  redis.connect()
    .then(() => logger.info("Redis connected — conversation history enabled"))
    .catch((e: unknown) => {
      logger.error({ err: e }, "Redis connection failed — falling back to in-memory cache");
      redis = null;
    });
}

// --- In-memory fallback ---
const memCache = new Map<string, { messages: ConversationEntry[]; updatedAt: number }>();

export async function getConversationHistory(chatId: string): Promise<ConversationEntry[]> {
  if (redis) {
    try {
      const raw = await redis.get(`${KEY_PREFIX}${chatId}`);
      return raw ? (JSON.parse(raw) as ConversationEntry[]) : [];
    } catch (e) {
      logger.error({ err: e, chatId }, "Redis get failed");
      return [];
    }
  }
  const s = memCache.get(chatId);
  if (!s || Date.now() - s.updatedAt > TTL_SECONDS * 1000) {
    memCache.delete(chatId);
    return [];
  }
  return s.messages;
}

export async function addToConversation(chatId: string, role: "user" | "assistant", content: string): Promise<void> {
  if (redis) {
    try {
      const key = `${KEY_PREFIX}${chatId}`;
      const raw = await redis.get(key);
      let msgs: ConversationEntry[] = raw ? JSON.parse(raw) : [];
      msgs.push({ role, content });
      if (msgs.length > MAX_ENTRIES) msgs = msgs.slice(-MAX_ENTRIES);
      await redis.set(key, JSON.stringify(msgs), "EX", TTL_SECONDS);
      return;
    } catch (e) {
      logger.error({ err: e, chatId }, "Redis set failed");
    }
  }
  let s = memCache.get(chatId);
  if (!s || Date.now() - s.updatedAt > TTL_SECONDS * 1000) {
    s = { messages: [], updatedAt: Date.now() };
  }
  s.messages.push({ role, content });
  if (s.messages.length > MAX_ENTRIES) s.messages = s.messages.slice(-MAX_ENTRIES);
  s.updatedAt = Date.now();
  memCache.set(chatId, s);
}

export async function clearConversation(chatId: string): Promise<void> {
  if (redis) {
    await redis.del(`${KEY_PREFIX}${chatId}`).catch((e) => logger.error({ err: e, chatId }, "Redis del failed"));
    return;
  }
  memCache.delete(chatId);
}

export async function disconnectRedis(): Promise<void> {
  if (redis) {
    await redis.quit().catch((_e: unknown) => {});
    logger.info("Redis disconnected");
  }
}
