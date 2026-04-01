/**
 * Per-user notification preference store.
 *
 * Stores muted notification types per Slack user ID.
 * Backed by Redis with in-memory fallback.
 *
 * Types that can be muted:
 *   escalations      — task escalation alerts
 *   email_alerts     — high/critical email notifications
 *   proactive        — proactive AI check recommendations
 *   task_reminders   — due-date / reminder notifications
 *   meeting_notes    — meeting action-item suggestions
 */
import { getRedis } from "./conversation-cache.js";
import { logger } from "./logger.js";

export type NotifType =
  | "escalations"
  | "email_alerts"
  | "proactive"
  | "task_reminders"
  | "meeting_notes";

export const ALL_NOTIF_TYPES: NotifType[] = [
  "escalations",
  "email_alerts",
  "proactive",
  "task_reminders",
  "meeting_notes",
];

// In-memory cache (slackUserId → Set<NotifType>)
const memPrefs = new Map<string, Set<string>>();

function redisKey(slackUserId: string): string {
  return `notifprefs:${slackUserId}`;
}

/** Load preferences from Redis into memCache for a user. */
async function loadFromRedis(slackUserId: string): Promise<Set<string>> {
  const redis = getRedis();
  if (redis) {
    try {
      const members = await redis.smembers(redisKey(slackUserId));
      const set = new Set<string>(members);
      memPrefs.set(slackUserId, set);
      return set;
    } catch (err) {
      logger.debug({ err }, "loadFromRedis notifprefs failed");
    }
  }
  return memPrefs.get(slackUserId) ?? new Set();
}

/** Mute a notification type for a user. */
export async function muteNotif(slackUserId: string, type: NotifType): Promise<void> {
  const set = memPrefs.get(slackUserId) ?? new Set<string>();
  set.add(type);
  memPrefs.set(slackUserId, set);
  const redis = getRedis();
  if (redis) {
    await redis.sadd(redisKey(slackUserId), type).catch(() => {});
  }
}

/** Unmute a notification type for a user. */
export async function unmuteNotif(slackUserId: string, type: NotifType): Promise<void> {
  const set = memPrefs.get(slackUserId);
  if (set) {
    set.delete(type);
    if (!set.size) memPrefs.delete(slackUserId);
  }
  const redis = getRedis();
  if (redis) {
    await redis.srem(redisKey(slackUserId), type).catch(() => {});
  }
}

/** Return the set of muted types for a user (loads from Redis if not cached). */
export async function getMutedTypes(slackUserId: string): Promise<Set<string>> {
  if (!memPrefs.has(slackUserId)) {
    return await loadFromRedis(slackUserId);
  }
  return memPrefs.get(slackUserId) ?? new Set();
}

/** Synchronous check (uses in-memory cache only — call getMutedTypes first to warm). */
export function isMuted(slackUserId: string, type: NotifType): boolean {
  return memPrefs.get(slackUserId)?.has(type) ?? false;
}
