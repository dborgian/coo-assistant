import { App as SlackApp } from "@slack/bolt";
import type { Bot } from "grammy";
import { eq, sql } from "drizzle-orm";
import { agent } from "../core/agent.js";
import { config } from "../config.js";
import { db } from "../models/database.js";
import { employees, messageLogs, tasks } from "../models/schema.js";
import { runInlineExtractors } from "../services/intelligence-pipeline.js";
import { logger } from "../utils/logger.js";
import type { AccessRole } from "./auth.js";

let slackApp: SlackApp | null = null;
let botRef: Bot | null = null;

// Cache user/channel names to avoid Slack API rate limits
const userNameCache = new Map<string, string>();
const channelNameCache = new Map<string, string>();

// Cache Slack user → employee mapping (5-min TTL)
interface SlackAuthUser { employeeId: string; role: AccessRole; name: string }
const slackAuthCache = new Map<string, { user: SlackAuthUser; cachedAt: number }>();
const SLACK_AUTH_TTL = 5 * 60 * 1000;

async function resolveSlackUser(slackUserId: string): Promise<SlackAuthUser | null> {
  const cached = slackAuthCache.get(slackUserId);
  if (cached && Date.now() - cached.cachedAt < SLACK_AUTH_TTL) return cached.user;

  const [emp] = await db
    .select({ id: employees.id, name: employees.name, accessRole: employees.accessRole, isActive: employees.isActive })
    .from(employees)
    .where(eq(employees.slackMemberId, slackUserId))
    .limit(1);

  if (!emp || !emp.isActive) return null;

  const user: SlackAuthUser = {
    employeeId: emp.id,
    role: (emp.accessRole as AccessRole) || "viewer",
    name: emp.name,
  };
  slackAuthCache.set(slackUserId, { user, cachedAt: Date.now() });
  return user;
}

async function handleSlackQuery(text: string, slackUserId: string, say: (msg: any) => Promise<any>, threadTs?: string): Promise<void> {
  const user = await resolveSlackUser(slackUserId);
  if (!user) {
    await say({ text: "Non sei registrato nel sistema. Chiedi all'admin di aggiungere il tuo Slack Member ID.", ...(threadTs ? { thread_ts: threadTs } : {}) });
    return;
  }

  logger.info({ slackUser: slackUserId, name: user.name, role: user.role, query: text.slice(0, 80) }, "Slack AI query");

  try {
    const response = await agent.answerQuery(text, user.role, user.employeeId);
    const reply = response.text || "Operazione completata.";

    // Split long messages (Slack limit ~4000 chars)
    const chunks = reply.match(/[\s\S]{1,3900}/g) ?? [reply];
    for (const chunk of chunks) {
      await say({ text: chunk, ...(threadTs ? { thread_ts: threadTs } : {}) });
    }
  } catch (err) {
    logger.error({ err, slackUser: slackUserId }, "Slack AI query failed");
    await say({ text: "Errore nell'elaborazione della richiesta.", ...(threadTs ? { thread_ts: threadTs } : {}) });
  }
}

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

  // App mention handler: @COO-Assistant in channels
  slackApp.event("app_mention", async ({ event, say }) => {
    try {
      // Strip the mention tag to get the actual query
      const text = (event.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
      if (!event.user) return;
      if (!text) {
        await say({ text: "Ciao! Scrivimi una domanda dopo avermi menzionato.", thread_ts: event.ts });
        return;
      }
      await handleSlackQuery(text, event.user, say, event.ts);
    } catch (err) {
      logger.error({ err }, "Error handling Slack app_mention");
    }
  });

  // Message handler: monitors channels + handles DMs
  slackApp.message(async ({ message, client, say }) => {
    try {
      // Handle DMs (direct messages to the bot)
      if ((message as any).channel_type === "im" && !((message as any).bot_id) && (message as any).text?.trim()) {
        const text = (message as any).text.trim();
        const userId = (message as any).user;
        if (userId) {
          await handleSlackQuery(text, userId, say);
          return;
        }
      }

      // Regular channel monitoring (existing behavior)
      await onSlackMessage(message, client);
    } catch (err) {
      logger.error({ err }, "Error processing Slack message");
    }
  });

  // Slack interactive button handlers
  slackApp.action("complete_task", async ({ action, ack, respond }) => {
    await ack();
    try {
      const taskId = (action as any).value;
      await db.update(tasks).set({ status: "done", updatedAt: new Date() }).where(eq(tasks.id, taskId));
      await respond({ text: "\u2705 Task completato!", replace_original: false });
      logger.info({ taskId }, "Task completed via Slack button");
    } catch (err) {
      logger.error({ err }, "Failed to complete task via Slack");
      await respond({ text: "Errore nel completare il task.", replace_original: false });
    }
  });

  slackApp.action("snooze_task", async ({ action, ack, respond }) => {
    await ack();
    try {
      const taskId = (action as any).value;
      const pauseUntil = new Date();
      pauseUntil.setDate(pauseUntil.getDate() + 3);
      await db.update(tasks).set({ escalationPausedUntil: pauseUntil, updatedAt: new Date() }).where(eq(tasks.id, taskId));
      await respond({ text: `\u23F8\uFE0F Escalation in pausa per 3 giorni.`, replace_original: false });
      logger.info({ taskId }, "Task snoozed via Slack button");
    } catch (err) {
      logger.error({ err }, "Failed to snooze task via Slack");
      await respond({ text: "Errore nello snooze del task.", replace_original: false });
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
    message.thread_ts ?? undefined,
    message.ts,
  );
}

async function handleSlackMessage(
  channelId: string,
  senderName: string,
  channelName: string,
  messageText: string,
  senderId?: string,
  threadTs?: string,
  messageTs?: string,
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

  // Store with source="slack" (full content + thread awareness)
  const [insertedMsg] = await db.insert(messageLogs)
    .values({
      source: "slack",
      chatTitle: `#${channelName}`,
      senderName,
      senderId: senderId ?? null,
      content: messageText.slice(0, 500),
      fullContent: messageText.length > 500 ? messageText : null,
      threadTs: threadTs ?? null,
      messageTs: messageTs ?? null,
      urgency: classification.urgency,
      needsReply: classification.needs_reply,
    })
    .returning({ id: messageLogs.id });

  // Intelligence pipeline (regex only, fire-and-forget)
  if (insertedMsg) {
    runInlineExtractors(insertedMsg.id, messageText, senderName, `#${channelName}`).catch(() => {});
  }

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

export async function sendSlackTaskNotification(
  channelId: string,
  text: string,
  taskId: string,
): Promise<boolean> {
  if (!slackApp) return false;

  try {
    await slackApp.client.chat.postMessage({
      channel: channelId,
      text,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "\u2705 Completa" },
              action_id: "complete_task",
              value: taskId,
              style: "primary",
            },
            {
              type: "button",
              text: { type: "plain_text", text: "\u23F8\uFE0F Snooze 3gg" },
              action_id: "snooze_task",
              value: taskId,
            },
          ],
        },
      ],
    });
    return true;
  } catch (err) {
    logger.error({ err, channel: channelId }, "Failed to send Slack task notification");
    return false;
  }
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
