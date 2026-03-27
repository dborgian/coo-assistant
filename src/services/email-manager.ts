import { google } from "googleapis";
import type { Bot } from "grammy";
import { and, eq, sql } from "drizzle-orm";
import { agent } from "../core/agent.js";
import { config } from "../config.js";
import { getGoogleAuth, isGoogleConfigured } from "../core/google-auth.js";
import type { GoogleAuth } from "../core/google-auth.js";
import { db } from "../models/database.js";
import { messageLogs } from "../models/schema.js";
import { logger } from "../utils/logger.js";

export interface EmailSummary {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
}

export async function getUnreadImportantEmails(maxResults = 10, authOverride?: GoogleAuth | null): Promise<EmailSummary[]> {
  const auth = authOverride ?? getGoogleAuth();
  if (!auth) return [];

  const gmail = google.gmail({ version: "v1", auth });

  try {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: "is:unread is:important",
      maxResults,
    });

    const messages = res.data.messages ?? [];
    const emails: EmailSummary[] = [];

    for (const msg of messages) {
      const detail = await gmail.users.messages.get({
        userId: "me",
        id: msg.id!,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date"],
      });

      const headers = detail.data.payload?.headers ?? [];
      const getHeader = (name: string) =>
        headers.find((h) => h.name === name)?.value ?? "";

      emails.push({
        id: msg.id!,
        from: getHeader("From"),
        subject: getHeader("Subject"),
        snippet: detail.data.snippet ?? "",
        date: getHeader("Date"),
      });
    }

    return emails;
  } catch (err) {
    logger.error({ err }, "Failed to fetch emails");
    return [];
  }
}

export async function checkImportantEmails(bot: Bot): Promise<void> {
  if (!isGoogleConfigured()) {
    logger.debug("Email check skipped — Google not configured");
    return;
  }

  const emails = await getUnreadImportantEmails(5);
  if (emails.length === 0) return;

  for (const email of emails) {
    // Dedup: skip if already notified
    const [alreadyLogged] = await db
      .select({ id: messageLogs.id })
      .from(messageLogs)
      .where(
        and(
          eq(messageLogs.source, "gmail"),
          sql`${messageLogs.content} LIKE ${'%' + email.id + '%'}`,
        ),
      )
      .limit(1);

    if (alreadyLogged) continue;

    // Classify urgency with AI
    const classification = await agent.classifyMessageUrgency(
      `Subject: ${email.subject}\n\n${email.snippet}`,
      email.from,
      "Gmail",
    );

    // Log to database
    await db.insert(messageLogs)
      .values({
        source: "gmail",
        chatTitle: "Gmail",
        senderName: email.from,
        content: `[${email.id}] ${email.subject}: ${email.snippet}`.slice(0, 500),
        urgency: classification.urgency,
        needsReply: classification.needs_reply,
      });

    // Notify if high/critical
    if (classification.urgency === "high" || classification.urgency === "critical") {
      const icon = classification.urgency === "critical" ? "\uD83D\uDD34" : "\uD83D\uDFE0";
      const msg = [
        `${icon} <b>Email ${classification.urgency.toUpperCase()}</b>`,
        `<b>Da:</b> ${escapeHtml(email.from)}`,
        `<b>Oggetto:</b> ${escapeHtml(email.subject)}`,
        `<i>${escapeHtml(email.snippet)}</i>`,
        classification.needs_reply ? "\n\u2709\uFE0F Richiede risposta" : "",
      ]
        .filter(Boolean)
        .join("\n");

      await bot.api.sendMessage(config.TELEGRAM_OWNER_CHAT_ID, msg, { parse_mode: "HTML" });
    }
  }
}

export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  authOverride?: GoogleAuth | null,
): Promise<boolean> {
  const auth = authOverride ?? getGoogleAuth();
  if (!auth) {
    logger.warn("Cannot send email — Google not configured");
    return false;
  }

  const gmail = google.gmail({ version: "v1", auth });

  // RFC 2047 encode subject if it contains non-ASCII (e.g. emoji)
  const encodedSubject = /^[\x20-\x7E]*$/.test(subject)
    ? subject
    : `=?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`;

  const rawMessage = [
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n");

  const encoded = Buffer.from(rawMessage)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  try {
    await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: encoded },
    });
    logger.info({ to, subject }, "Email sent successfully");
    return true;
  } catch (err) {
    logger.error({ err, to, subject }, "Failed to send email");
    return false;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
