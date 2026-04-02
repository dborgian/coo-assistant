import { App as SlackApp } from "@slack/bolt";
import { and, eq, gte, sql } from "drizzle-orm";
import { agent } from "../core/agent.js";
import { config } from "../config.js";
import { db } from "../models/database.js";
import { clients, employees, intelligenceEvents, messageLogs, tasks } from "../models/schema.js";
import { runInlineExtractors } from "../services/intelligence-pipeline.js";
import { updateNotionTaskStatus } from "../services/notion-sync.js";
import { completeGoogleTask } from "../services/google-tasks-sync.js";
import { deleteCalendarEvent } from "../services/calendar-sync.js";
import { logger } from "../utils/logger.js";
import { initNotify } from "../utils/notify.js";
import type { AccessRole } from "./auth-types.js";
import { registerSlashCommands } from "./slack-commands.js";
import { registerDashboardActions } from "./slack-dashboard.js";
import { registerOAuthCommands } from "./onboarding.js";
import { registerMeetingApprovals } from "./meeting-approvals.js";
import { registerDraftApprovals } from "./draft-approvals.js";

let slackApp: SlackApp | null = null;
let slackBotUserId: string | null = null;

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
export interface SlackAuthUser { employeeId: string; role: AccessRole; name: string }
const slackAuthCache = new Map<string, { user: SlackAuthUser; cachedAt: number }>();
const SLACK_AUTH_TTL = 5 * 60 * 1000;

export function clearSlackAuthCache(slackUserId?: string): void {
  if (slackUserId) {
    slackAuthCache.delete(slackUserId);
  } else {
    slackAuthCache.clear();
  }
}

export async function resolveSlackUser(slackUserId: string): Promise<SlackAuthUser | null> {
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

/** Split a long message at paragraph/line/word boundaries, never mid-word or mid-markdown. */
function splitSlackMessage(text: string, maxLen = 3900): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf("\n\n", maxLen);
    if (splitAt < 500) splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < 500) splitAt = remaining.lastIndexOf(" ", maxLen);
    if (splitAt < 1) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
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

/** Fetch recent messages from a Slack channel/thread for context injection */
async function fetchChannelContext(
  channelId: string,
  threadTs?: string,
  limit = 5,
): Promise<string> {
  if (!slackApp) return "";
  try {
    const result = threadTs
      ? await slackApp.client.conversations.replies({ channel: channelId, ts: threadTs, limit, inclusive: false })
      : await slackApp.client.conversations.history({ channel: channelId, limit });
    const msgs = (result.messages ?? [])
      .filter((m: any) => m.user && m.user !== slackBotUserId && m.text)
      .reverse(); // chronological order
    if (!msgs.length) return "";
    const lines = msgs.map((m: any) => {
      const name = userNameCache.get(m.user) ?? m.user;
      return `[${name}]: ${m.text}`;
    });
    return "\n\nCONTESTO RECENTE DEL CANALE:\n" + lines.join("\n");
  } catch (err) {
    logger.warn({ err, channelId }, "Failed to fetch channel context");
    return "";
  }
}

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
    await say({
      text: [
        "Non sei ancora registrato nel sistema COO Assistant.",
        "",
        "*Come procedere:*",
        "1. Chiedi all'admin (owner) di aggiungerti con `/coo-add-employee`",
        "2. Una volta registrato, usa `/coo-connect-google` per collegare il tuo Google Calendar",
        "3. Poi potrai usare `/coo-dashboard`, `/coo-tasks` e chattare direttamente con me",
        "",
        "_Il tuo Slack Member ID è: `" + slackUserId + "`_ — comunicalo all'admin se necessario.",
      ].join("\n"),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    return;
  }

  logger.info({ slackUser: slackUserId, name: user.name, role: user.role, query: text.slice(0, 80) }, "Slack AI query");

  // Add hourglass reaction to user's message to signal processing (FIX 7)
  if (slackApp && channelId && messageTs) {
    slackApp.client.reactions.add({ channel: channelId, timestamp: messageTs, name: "hourglass_flowing_sand" }).catch(() => {});
  }

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
    // Use slackUserId as chatId so conversation history is per-user, not per-channel
    const response = await agent.answerQuery(text, user.role, user.employeeId, user.name, slackUserId);
    const reply = response.text || "Operazione completata.";

    // Delete waiting message
    if (slackApp && channelId && waitingTs) {
      await slackApp.client.chat.delete({ channel: channelId, ts: waitingTs }).catch(() => {});
    }

    // Split long messages at paragraph/line boundaries (FIX 5)
    const chunks = splitSlackMessage(reply);
    for (const chunk of chunks) {
      await say({ text: chunk, ...(threadTs ? { thread_ts: threadTs } : {}) });
    }

    // Upload any files (e.g. PDF reports) generated by AI tools
    if (slackApp && channelId && response.files?.length) {
      for (const f of response.files) {
        const uploadArgs: Parameters<typeof slackApp.client.filesUploadV2>[0] = {
          channel_id: channelId,
          file: f.buffer,
          filename: f.filename,
        };
        if (threadTs) (uploadArgs as any).thread_ts = threadTs;
        await slackApp.client.filesUploadV2(uploadArgs).catch((err) => logger.error({ err, filename: f.filename }, "Failed to upload file to Slack"));
      }
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

    await say({ text: "Mi dispiace, si è verificato un errore. Riprova tra qualche secondo.", ...(threadTs ? { thread_ts: threadTs } : {}) });
    // Replace hourglass with X on error
    if (slackApp && channelId && messageTs) {
      await slackApp.client.reactions.remove({ channel: channelId, timestamp: messageTs, name: "hourglass_flowing_sand" }).catch(() => {});
      await slackApp.client.reactions.add({ channel: channelId, timestamp: messageTs, name: "x" }).catch(() => {});
    }
  }
}

export async function startSlackMonitor(): Promise<boolean> {
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

  // Initialize notification layer
  initNotify(slackApp);

  // Register slash commands, dashboard actions, and OAuth commands
  registerSlashCommands(slackApp, resolveSlackUser);
  registerDashboardActions(slackApp, resolveSlackUser);
  registerOAuthCommands(slackApp);
  registerMeetingApprovals(slackApp);
  registerDraftApprovals(slackApp);

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

  // FIX 10: Cache bot user ID BEFORE registering message handlers to avoid @mention race at startup
  try {
    const authResult = await slackApp.client.auth.test();
    slackBotUserId = (authResult.user_id as string | undefined) ?? null;
    logger.info({ slackBotUserId }, "Slack bot user ID cached");
  } catch (err) {
    logger.warn({ err }, "Failed to cache Slack bot user ID — @mention filter disabled");
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

  // Message handler: monitors channels + handles DMs + responds on @mention
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

      // Handle DMs — always respond; pass thread_ts so replies stay in thread (FIX 9)
      if (msg.channel_type === "im" && userId) {
        await handleSlackQuery(text, userId, say, channelId, msgTs, msg.thread_ts);
        return;
      }

      // Channel messages — run monitoring pipeline for regular messages, respond only on @mention (FIX 2)
      if (userId) {
        const isBotMention = !!(slackBotUserId && text.includes(`<@${slackBotUserId}>`));

        if (!isBotMention) {
          // Regular channel message — run monitoring pipeline, don't respond
          onSlackMessage(message, client).catch(() => {});
          return;
        }

        // Bot @mention — respond with AI (skip monitoring pipeline to avoid double-reply)
        const cleanText = text.replace(/<@[A-Z0-9]+>/g, "").trim();
        const channelCtx = channelId ? await fetchChannelContext(channelId, msg.thread_ts, 5) : "";
        const queryText = cleanText
          ? cleanText + channelCtx
          : channelCtx
            ? "L'utente ti ha menzionato nel canale. Analizza il contesto recente e rispondi in modo utile." + channelCtx
            : "L'utente ti ha menzionato. Salutalo e chiedi come puoi aiutare.";
        await handleSlackQuery(queryText, userId, say, channelId, msgTs, msg.thread_ts ?? msgTs);
      }
    } catch (err) {
      logger.error({ err }, "Error processing Slack message");
    }
  });

  // Slack interactive button handlers
  slackApp.action("complete_task", async ({ action, ack, respond, body }) => {
    await ack();
    try {
      const taskId = (action as any).value;
      const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
      if (!task) {
        await respond({ text: "Task non trovato.", replace_original: false });
        return;
      }
      // Auth check: owner/admin or task assignee only (FIX 6)
      const actingUser = await resolveSlackUser((body as any).user.id);
      if (actingUser) {
        const canComplete = actingUser.role === "owner" || actingUser.role === "admin" || task.assignedTo === actingUser.employeeId;
        if (!canComplete) {
          await respond({ text: "Non hai i permessi per completare questo task.", replace_original: false });
          return;
        }
      }
      await db.update(tasks).set({ status: "done", updatedAt: new Date() }).where(eq(tasks.id, taskId));

      // Sync to Notion
      if (task.externalId?.startsWith("notion:")) {
        const notionPageId = task.externalId.replace(/^notion(-done)?:/, "");
        updateNotionTaskStatus(notionPageId, "done").catch((e) =>
          logger.error({ err: e, notionPageId }, "Notion status sync from Slack failed"),
        );
      }

      // Sync to Google Tasks
      completeGoogleTask(taskId).catch(() => {});

      // Remove associated calendar event if present
      if (task.calendarEventId) {
        deleteCalendarEvent(task.calendarEventId).catch((e) =>
          logger.error({ err: e, eventId: task.calendarEventId }, "Calendar event delete on Slack complete failed"),
        );
      }

      await respond({ text: "\u2705 Task completato!", replace_original: false });
      logger.info({ taskId }, "Task completed via Slack button");
    } catch (err) {
      logger.error({ err }, "Failed to complete task via Slack");
      await respond({ text: "Errore nel completare il task.", replace_original: false });
    }
  });

  // Commitment close button (from /coo-commitments)
  slackApp.action(/^commit_close_/, async ({ body, ack, respond }) => {
    await ack();
    const actionId = ((body as any).actions?.[0]?.action_id ?? "") as string;
    const commitId = actionId.replace("commit_close_", "");
    try {
      await db.update(intelligenceEvents).set({ status: "fulfilled" }).where(eq(intelligenceEvents.id, commitId));
      await respond({ text: "✅ Commitment chiuso.", replace_original: false });
      logger.info({ commitId }, "Commitment closed via Slack button");
    } catch (err) {
      logger.error({ err, commitId }, "Failed to close commitment");
      await respond({ text: "Errore nella chiusura del commitment.", replace_original: false });
    }
  });

  slackApp.action("snooze_task", async ({ action, ack, respond, body }) => {
    await ack();
    try {
      const taskId = (action as any).value;
      // Auth check: owner/admin or task assignee only (FIX 6)
      const [taskForAuth] = await db.select({ assignedTo: tasks.assignedTo }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
      if (taskForAuth) {
        const actingUser = await resolveSlackUser((body as any).user.id);
        if (actingUser) {
          const canSnooze = actingUser.role === "owner" || actingUser.role === "admin" || taskForAuth.assignedTo === actingUser.employeeId;
          if (!canSnooze) {
            await respond({ text: "Non hai i permessi per questa azione.", replace_original: false });
            return;
          }
        }
      }
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

export async function sendSlackBlocks(channelId: string, text: string, blocks: unknown[]): Promise<boolean> {
  if (!slackApp) return false;
  try {
    await (slackApp.client.chat.postMessage as Function)({ channel: channelId, text, blocks });
    return true;
  } catch (err) {
    logger.error({ err, channel: channelId }, "Failed to send Slack blocks");
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
