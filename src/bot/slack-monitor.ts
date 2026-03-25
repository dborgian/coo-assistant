import { App as SlackApp } from "@slack/bolt";
import type { Bot } from "grammy";
import { agent } from "../core/agent.js";
import { config } from "../config.js";
import { db } from "../models/database.js";
import { messageLogs } from "../models/schema.js";
import { logger } from "../utils/logger.js";

let slackApp: SlackApp | null = null;
let botRef: Bot | null = null;

// Cache user/channel names to avoid Slack API rate limits
const userNameCache = new Map<string, string>();
const channelNameCache = new Map<string, string>();

export async function startSlackMonitor(bot: Bot): Promise<boolean> {
  botRef = bot;

  if (!config.SLACK_BOT_TOKEN || !config.SLACK_APP_TOKEN) {
    logger.warn("Slack credentials not configured — Slack monitoring disabled");
    return false;
  }

  slackApp = new SlackApp({
    token: config.SLACK_BOT_TOKEN,
    appToken: config.SLACK_APP_TOKEN,
    signingSecret: config.SLACK_SIGNING_SECRET || undefined,
    socketMode: true,
  });

  slackApp.message(async ({ message, client }) => {
    try {
      await onSlackMessage(message, client);
    } catch (err) {
      logger.error({ err }, "Error processing Slack message");
    }
  });

  await slackApp.start();
  logger.info(
    { monitoredChannels: config.MONITORED_SLACK_CHANNELS },
    "Slack monitoring active",
  );
  return true;
}

async function onSlackMessage(message: any, client: any): Promise<void> {
  // Skip bot messages
  if (message.subtype === "bot_message" || message.bot_id) return;
  if (!message.text?.trim()) return;

  const channelId: string = message.channel;

  // Only process monitored channels (if list configured)
  if (
    config.MONITORED_SLACK_CHANNELS.length &&
    !config.MONITORED_SLACK_CHANNELS.includes(channelId)
  ) {
    return;
  }

  // Resolve sender name (with cache)
  let senderName = "Unknown";
  if (message.user) {
    if (userNameCache.has(message.user)) {
      senderName = userNameCache.get(message.user)!;
    } else {
      try {
        const userInfo = await client.users.info({ user: message.user });
        senderName =
          userInfo.user?.real_name || userInfo.user?.name || "Unknown";
        userNameCache.set(message.user, senderName);
      } catch {
        /* fallback to "Unknown" */
      }
    }
  }

  // Resolve channel name (with cache)
  let channelName = channelId;
  if (channelNameCache.has(channelId)) {
    channelName = channelNameCache.get(channelId)!;
  } else {
    try {
      const channelInfo = await client.conversations.info({
        channel: channelId,
      });
      channelName = channelInfo.channel?.name || channelId;
      channelNameCache.set(channelId, channelName);
    } catch {
      /* fallback to ID */
    }
  }

  await handleSlackMessage(
    channelId,
    senderName,
    channelName,
    message.text,
    message.user,
  );
}

async function handleSlackMessage(
  channelId: string,
  senderName: string,
  channelName: string,
  messageText: string,
  senderId?: string,
): Promise<void> {
  logger.info(
    {
      channel: channelName,
      sender: senderName,
      preview: messageText.slice(0, 80),
    },
    "New Slack message detected",
  );

  // Reuse existing AI classification
  const classification = await agent.classifyMessageUrgency(
    messageText,
    senderName,
    channelName,
  );

  // Store with source="slack"
  await db.insert(messageLogs)
    .values({
      source: "slack",
      chatTitle: `#${channelName}`,
      senderName,
      senderId: senderId ?? null,
      content: messageText.slice(0, 500),
      urgency: classification.urgency,
      needsReply: classification.needs_reply,
    });

  // Notify owner via Telegram for ALL Slack messages
  {
    const urgency = classification.urgency.toUpperCase();
    const urgencyIcon =
      classification.urgency === "critical" ? "\uD83D\uDD34" :
      classification.urgency === "high" ? "\uD83D\uDFE0" :
      classification.urgency === "normal" ? "\uD83D\uDFE1" : "\uD83D\uDFE2";
    const notification =
      `${urgencyIcon} <b>Slack — #${channelName}</b>\n` +
      `<b>From:</b> ${senderName}\n` +
      `${messageText.slice(0, 500)}`;

    try {
      await botRef?.api.sendMessage(
        config.TELEGRAM_OWNER_CHAT_ID,
        notification,
        { parse_mode: "HTML" },
      );
    } catch (err) {
      logger.error({ err }, "Failed to notify owner about Slack message");
    }
  }
}

export async function stopSlackMonitor(): Promise<void> {
  if (slackApp) {
    await slackApp.stop();
    slackApp = null;
    logger.info("Slack monitor disconnected");
  }
  botRef = null;
}

export function getMonitoredSlackChannels(): string[] {
  return config.MONITORED_SLACK_CHANNELS;
}

export function addMonitoredSlackChannel(channelId: string): void {
  if (!config.MONITORED_SLACK_CHANNELS.includes(channelId)) {
    config.MONITORED_SLACK_CHANNELS.push(channelId);
  }
}

export function removeMonitoredSlackChannel(channelId: string): void {
  const idx = config.MONITORED_SLACK_CHANNELS.indexOf(channelId);
  if (idx !== -1) config.MONITORED_SLACK_CHANNELS.splice(idx, 1);
}

export async function sendSlackMessage(channelId: string, text: string): Promise<boolean> {
  if (!slackApp) {
    logger.warn("Slack not connected - cannot send message");
    return false;
  }

  try {
    await slackApp.client.chat.postMessage({
      channel: channelId,
      text,
    });
    logger.info({ channel: channelId }, "Slack message sent");
    return true;
  } catch (err) {
    logger.error({ err, channel: channelId }, "Failed to send Slack message");
    return false;
  }
}
