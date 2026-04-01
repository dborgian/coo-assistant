/**
 * Slack-based notification layer — replaces src/utils/telegram.ts
 *
 * All notifications (owner alerts, employee messages, assignee notifications)
 * route through Slack DMs or the configured notifications channel.
 *
 * Usage:
 *   1. Call initNotify(slackApp) once after the Slack app is created.
 *   2. Use sendOwnerNotification(), notifyAssigneeAndOwner(), sendEmployeeNotification()
 *      in place of the old Telegram equivalents.
 */
import type { App as SlackApp } from "@slack/bolt";
import { eq } from "drizzle-orm";
import { db } from "../models/database.js";
import { employees } from "../models/schema.js";
import { config } from "../config.js";
import { logger } from "./logger.js";

let app: SlackApp | null = null;

/** Initialize with the Slack app instance (call from startSlackMonitor). */
export function initNotify(slackApp: SlackApp): void {
  app = slackApp;
}

/** Convert basic HTML to Slack mrkdwn. */
export function htmlToMrkdwn(html: string): string {
  return html
    .replace(/<b>(.*?)<\/b>/gi, "*$1*")
    .replace(/<strong>(.*?)<\/strong>/gi, "*$1*")
    .replace(/<i>(.*?)<\/i>/gi, "_$1_")
    .replace(/<em>(.*?)<\/em>/gi, "_$1_")
    .replace(/<a href="([^"]+)"[^>]*>(.*?)<\/a>/gi, "<$1|$2>")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** Open a DM with a Slack member and post a message. Returns true on success. */
export async function sendSlackDM(slackMemberId: string, text: string): Promise<boolean> {
  if (!app) {
    logger.warn({ slackMemberId }, "notify: Slack app not initialized");
    return false;
  }
  try {
    const conv = await app.client.conversations.open({ users: slackMemberId });
    const channelId = (conv.channel as any)?.id as string | undefined;
    if (!channelId) return false;
    await app.client.chat.postMessage({
      channel: channelId,
      text: htmlToMrkdwn(text),
    });
    return true;
  } catch (err) {
    logger.error({ err, slackMemberId }, "sendSlackDM failed");
    return false;
  }
}

/** Resolve the owner's Slack member ID: from employees table or env var fallback. */
async function resolveOwnerSlackId(): Promise<string | null> {
  try {
    const [owner] = await db
      .select({ slackMemberId: employees.slackMemberId })
      .from(employees)
      .where(eq(employees.accessRole, "owner"))
      .limit(1);
    if (owner?.slackMemberId) return owner.slackMemberId;
  } catch (err) {
    logger.error({ err }, "resolveOwnerSlackId DB query failed");
  }
  return config.SLACK_OWNER_MEMBER_ID || null;
}

/** Send a notification to the owner via Slack DM. Falls back to notifications channel. */
export async function sendOwnerNotification(text: string): Promise<void> {
  if (!app) return;
  const mrkdwn = htmlToMrkdwn(text);
  const ownerId = await resolveOwnerSlackId();
  if (ownerId) {
    const sent = await sendSlackDM(ownerId, mrkdwn);
    if (sent) return;
  }
  // Fallback: post to notifications channel
  const channel = config.SLACK_NOTIFICATIONS_CHANNEL;
  if (channel) {
    try {
      await app.client.chat.postMessage({ channel, text: mrkdwn });
    } catch (err) {
      logger.error({ err }, "sendOwnerNotification channel fallback failed");
    }
  }
}

/** Send a notification to both the assignee and the owner via Slack DM. */
export async function notifyAssigneeAndOwner(
  assignedTo: string | null,
  text: string,
): Promise<void> {
  if (!app) return;

  if (assignedTo) {
    try {
      const [emp] = await db
        .select({ slackMemberId: employees.slackMemberId })
        .from(employees)
        .where(eq(employees.id, assignedTo))
        .limit(1);
      if (emp?.slackMemberId) {
        await sendSlackDM(emp.slackMemberId, text);
      }
    } catch (err) {
      logger.error({ err, assignedTo }, "notifyAssigneeAndOwner: failed to notify assignee");
    }
  }

  await sendOwnerNotification(text);
}

/** Send a notification to a specific employee by their DB id. Returns true on success. */
export async function sendEmployeeNotification(employeeId: string, text: string): Promise<boolean> {
  if (!app) return false;
  try {
    const [emp] = await db
      .select({ slackMemberId: employees.slackMemberId })
      .from(employees)
      .where(eq(employees.id, employeeId))
      .limit(1);
    if (!emp?.slackMemberId) return false;
    return await sendSlackDM(emp.slackMemberId, htmlToMrkdwn(text));
  } catch (err) {
    logger.error({ err, employeeId }, "sendEmployeeNotification failed");
    return false;
  }
}
