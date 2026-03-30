import { App as SlackApp } from "@slack/bolt";
import type { Bot } from "grammy";
import { and, eq, gte, sql } from "drizzle-orm";
import { agent } from "../core/agent.js";
import { config } from "../config.js";
import { db } from "../models/database.js";
import { clients, employees, intelligenceEvents, messageLogs, tasks } from "../models/schema.js";
import { runInlineExtractors } from "../services/intelligence-pipeline.js";
import { logger } from "../utils/logger.js";
import type { AccessRole } from "./auth.js";

let slackApp: SlackApp | null = null;
let botRef: Bot | null = null;

// Cache user/channel names to avoid Slack API rate limits
const userNameCache = new Map<string, string>();
const channelNameCache = new Map<string, string>();

// Auto-discovered channels where the bot is a member
const botChannels = new Map<string, string>(); // channelId → channelName

/** Get the best channel for notifications (configured or first auto-discovered) */
export function getNotificationsChannel(): string | null {
  if (config.SLACK_NOTIFICATIONS_CHANNEL) return config.SLACK_NOTIFICATIONS_CHANNEL;
  // Fallback to first discovered channel
  const first = botChannels.keys().next();
  return first.done ? null : first.value;
}

/** Get all channels the bot is in */
export function getBotChannels(): Map<string, string> {
  return botChannels;
}

// Cache Slack user → employee mapping (5-min TTL)
interface SlackAuthUser { employeeId: string; role: AccessRole; name: string }
const slackAuthCache = new Map<string, { user: SlackAuthUser; cachedAt: number }>();
const SLACK_AUTH_TTL = 5 * 60 * 1000;

async function resolveSlackUser(slackUserId: string): Promise<SlackAuthUser | null> {
  const cached = slackAuthCache.get(slackUserId);
  if (cached && Date.now() - cached.cachedAt < SLACK_AUTH_TTL) return cached.user;

  // Try direct lookup by slackMemberId
  const [emp] = await db
    .select({ id: employees.id, name: employees.name, accessRole: employees.accessRole, isActive: employees.isActive })
    .from(employees)
    .where(eq(employees.slackMemberId, slackUserId))
    .limit(1);

  if (emp && emp.isActive) {
    const user: SlackAuthUser = {
      employeeId: emp.id,
      role: (emp.accessRole as AccessRole) || "viewer",
      name: emp.name,
    };
    slackAuthCache.set(slackUserId, { user, cachedAt: Date.now() });
    return user;
  }

  // Auto-link: fetch Slack profile and match by email or name
  if (slackApp) {
    try {
      const slackProfile = await slackApp.client.users.info({ user: slackUserId });
      const email = slackProfile.user?.profile?.email;
      const realName = slackProfile.user?.real_name || slackProfile.user?.name;
      const slackUsername = slackProfile.user?.name ?? null;

      // Try email match first, then name match
      let matched: typeof emp | undefined;
      if (email) {
        const [byEmail] = await db.select({ id: employees.id, name: employees.name, accessRole: employees.accessRole, isActive: employees.isActive })
          .from(employees).where(and(eq(employees.email, email), eq(employees.isActive, true))).limit(1);
        if (!byEmail && email) {
          const [byGoogleEmail] = await db.select({ id: employees.id, name: employees.name, accessRole: employees.accessRole, isActive: employees.isActive })
            .from(employees).where(and(sql`${employees.googleEmail} = ${email}`, eq(employees.isActive, true))).limit(1);
          matched = byGoogleEmail;
        } else {
          matched = byEmail;
        }
      }
      if (!matched && realName) {
        const [byName] = await db.select({ id: employees.id, name: employees.name, accessRole: employees.accessRole, isActive: employees.isActive })
          .from(employees).where(and(sql`${employees.name} ILIKE ${realName}`, eq(employees.isActive, true))).limit(1);
        matched = byName;
      }

      if (matched) {
        // Link Slack ID to employee
        await db.update(employees).set({
          slackMemberId: slackUserId,
          slackUsername,
          updatedAt: new Date(),
        }).where(eq(employees.id, matched.id));

        logger.info({ slackUserId, employeeName: matched.name, email, realName }, "Auto-linked Slack user to employee");

        const user: SlackAuthUser = {
          employeeId: matched.id,
          role: (matched.accessRole as AccessRole) || "viewer",
          name: matched.name,
        };
        slackAuthCache.set(slackUserId, { user, cachedAt: Date.now() });
        return user;
      }
    } catch (err) {
      logger.debug({ err, slackUserId }, "Failed to auto-link Slack user");
    }
  }

  return null;
}

const WAITING_PHRASES = [
  "Okay, dammi un attimo...",
  "Ci penso su un secondo...",
  "Aspetta, ci sto lavorando...",
  "Un momento, sto elaborando...",
  "Fammi controllare...",
  "Sì sì, arrivo...",
  "Sto guardando, un sec...",
];

async function handleSlackQuery(
  text: string,
  slackUserId: string,
  say: (msg: any) => Promise<any>,
  channelId?: string,
  messageTs?: string,
  threadTs?: string,
): Promise<void> {
  const user = await resolveSlackUser(slackUserId);
  if (!user) {
    await say({ text: "Non sei registrato nel sistema. Chiedi all'admin di aggiungere il tuo Slack Member ID.", ...(threadTs ? { thread_ts: threadTs } : {}) });
    return;
  }

  logger.info({ slackUser: slackUserId, name: user.name, role: user.role, query: text.slice(0, 80) }, "Slack AI query");

  // Send casual waiting message directly in channel (not thread, so it's visible)
  const phrase = WAITING_PHRASES[Math.floor(Math.random() * WAITING_PHRASES.length)];
  let waitingTs: string | undefined;
  if (slackApp && channelId) {
    try {
      const waitingMsg = await slackApp.client.chat.postMessage({
        channel: channelId,
        text: phrase,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      waitingTs = waitingMsg.ts as string | undefined;
      logger.info({ channelId, waitingTs, phrase }, "Slack waiting message posted");
    } catch (err) {
      logger.warn({ err, channelId }, "Failed to post Slack waiting message");
    }
  }

  try {
    const response = await agent.answerQuery(text, user.role, user.employeeId, user.name);
    const reply = response.text || "Operazione completata.";

    // Delete waiting message
    if (slackApp && channelId && waitingTs) {
      await slackApp.client.chat.delete({ channel: channelId, ts: waitingTs }).catch(() => {});
    }

    // Split long messages (Slack limit ~4000 chars)
    const chunks = reply.match(/[\s\S]{1,3900}/g) ?? [reply];
    for (const chunk of chunks) {
      await say({ text: chunk, ...(threadTs ? { thread_ts: threadTs } : {}) });
    }

    // Replace hourglass with checkmark
    if (slackApp && channelId && messageTs) {
      await slackApp.client.reactions.remove({ channel: channelId, timestamp: messageTs, name: "hourglass_flowing_sand" }).catch(() => {});
      await slackApp.client.reactions.add({ channel: channelId, timestamp: messageTs, name: "white_check_mark" }).catch(() => {});
    }
  } catch (err) {
    logger.error({ err, slackUser: slackUserId }, "Slack AI query failed");

    // Delete waiting message on error too
    if (slackApp && channelId && waitingTs) {
      await slackApp.client.chat.delete({ channel: channelId, ts: waitingTs }).catch(() => {});
    }

    await say({ text: "Errore nell'elaborazione della richiesta.", ...(threadTs ? { thread_ts: threadTs } : {}) });
    // Replace hourglass with X on error
    if (slackApp && channelId && messageTs) {
      await slackApp.client.reactions.remove({ channel: channelId, timestamp: messageTs, name: "hourglass_flowing_sand" }).catch(() => {});
      await slackApp.client.reactions.add({ channel: channelId, timestamp: messageTs, name: "x" }).catch(() => {});
    }
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

  // Auto-discover channels the bot is a member of
  try {
    const convos = await slackApp.client.conversations.list({ types: "public_channel,private_channel", limit: 200 });
    for (const ch of convos.channels ?? []) {
      if (ch.is_member && ch.id && ch.name) {
        botChannels.set(ch.id, ch.name);
        channelNameCache.set(ch.id, ch.name);
      }
    }
    logger.info({ channelCount: botChannels.size, channels: [...botChannels.values()] }, "Slack channels auto-discovered");
  } catch (err) {
    logger.debug({ err }, "Failed to auto-discover Slack channels");
  }

  // Auto-detect when bot is added to a new channel
  slackApp.event("member_joined_channel" as any, async ({ event }: any) => {
    try {
      // Check if it's the bot that joined
      const botInfo = await slackApp!.client.auth.test();
      if (event.user === botInfo.user_id && event.channel) {
        const chInfo = await slackApp!.client.conversations.info({ channel: event.channel });
        const name = (chInfo.channel as any)?.name ?? event.channel;
        botChannels.set(event.channel, name);
        channelNameCache.set(event.channel, name);
        logger.info({ channel: name, channelId: event.channel }, "Bot added to new Slack channel");
      }
    } catch {
      // ignore
    }
  });

  // App mention handler: @COO-Assistant in channels (kept for backwards compat)
  slackApp.event("app_mention", async ({ event, say }) => {
    try {
      const text = (event.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
      if (!event.user) return;
      if (!text) {
        await say({ text: "Ciao! Chiedimi quello che vuoi.", thread_ts: event.ts });
        return;
      }
      await handleSlackQuery(text, event.user, say, event.channel, event.ts, event.ts);
    } catch (err) {
      logger.error({ err }, "Error handling Slack app_mention");
    }
  });

  // Message handler: monitors channels + handles DMs + proactive responses
  slackApp.message(async ({ message, client, say }) => {
    try {
      const msg = message as any;
      // Skip bot messages
      if (msg.bot_id || msg.subtype === "bot_message") return;
      if (!msg.text?.trim()) return;

      const text = msg.text.trim();
      const userId = msg.user;
      const channelId = msg.channel;
      const msgTs = msg.ts;

      // Handle DMs — always respond
      if (msg.channel_type === "im" && userId) {
        await handleSlackQuery(text, userId, say, channelId, msgTs);
        return;
      }

      // Channel messages — respond proactively to all messages in channels where the bot is present
      if (userId) {
        // Run monitoring pipeline in parallel (logging, classification, Telegram notification)
        onSlackMessage(message, client).catch(() => {});

        // Respond to the message via AI
        await handleSlackQuery(text, userId, say, channelId, msgTs, msg.thread_ts ?? msgTs);
      }
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
    runInlineExtractors(insertedMsg.id, messageText, senderName, `#${channelName}`, threadTs).catch(() => {});
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

  // Phase 6: Contextual proactive participation (fire-and-forget)
  checkProactiveIntervention(channelId, channelName, messageText, threadTs, messageTs).catch(() => {});
}

/**
 * Check if the bot should proactively intervene in a conversation.
 * Triggers: client mention with open tasks, question matching knowledge base.
 */
async function checkProactiveIntervention(
  channelId: string,
  channelName: string,
  messageText: string,
  threadTs?: string,
  messageTs?: string,
): Promise<void> {
  if (!slackApp) return;

  // 1. Client mention — surface open tasks and project status
  const allClients = await db.select({ name: clients.name, id: clients.id }).from(clients).where(eq(clients.isActive, true));
  for (const client of allClients) {
    if (messageText.toLowerCase().includes(client.name.toLowerCase()) && client.name.length > 2) {
      const openTasks = await db.select({ title: tasks.title, status: tasks.status, priority: tasks.priority, dueDate: tasks.dueDate })
        .from(tasks)
        .where(and(eq(tasks.clientId, client.id), sql`${tasks.status} IN ('pending', 'in_progress')`));

      if (openTasks.length) {
        const taskList = openTasks.slice(0, 5).map((t) => `- ${t.title} (${t.status}, ${t.priority}${t.dueDate ? `, scade ${new Date(t.dueDate).toLocaleDateString("it-IT")}` : ""})`).join("\n");
        await slackApp.client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs ?? messageTs,
          text: `Ho notato che si parla di *${client.name}*. Ci sono ${openTasks.length} task attivi:\n${taskList}`,
        }).catch(() => {});
        logger.debug({ client: client.name, channel: channelName }, "Proactive: surfaced client tasks");
      }
      break; // Only surface for the first matched client
    }
  }

  // 2. Question detection — surface relevant knowledge
  const isQuestion = /\?$|\bcome\b|\bperche\b|\bquando\b|\bdove\b|\bchi\b|\bwhat\b|\bhow\b|\bwhy\b|\bwhen\b/i.test(messageText);
  if (isQuestion && messageText.length > 20) {
    const recentDecisions = await db.select({ content: intelligenceEvents.content, channel: intelligenceEvents.channel })
      .from(intelligenceEvents)
      .where(and(
        eq(intelligenceEvents.type, "decision"),
        eq(intelligenceEvents.status, "active"),
        gte(intelligenceEvents.detectedAt, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)),
      ));

    if (recentDecisions.length) {
      // Simple keyword matching — find decisions related to the question
      const words = messageText.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
      const relevant = recentDecisions.filter((d) =>
        words.some((w) => d.content.toLowerCase().includes(w)),
      );

      if (relevant.length > 0 && relevant.length <= 3) {
        const decisionList = relevant.map((d) => `- "${d.content.slice(0, 120)}" (${d.channel ?? "?"})`).join("\n");
        await slackApp.client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs ?? messageTs,
          text: `Potrebbe essere rilevante — decisioni recenti correlate:\n${decisionList}`,
        }).catch(() => {});
        logger.debug({ channel: channelName }, "Proactive: surfaced relevant decisions");
      }
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
