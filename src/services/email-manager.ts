import { google } from "googleapis";
import { and, eq, sql } from "drizzle-orm";
import { agent } from "../core/agent.js";
import { sendOwnerNotification } from "../utils/notify.js";
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

export async function checkImportantEmails(): Promise<void> {
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

      await sendOwnerNotification(msg);
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

export async function searchEmails(query: string, maxResults = 5, authOverride?: GoogleAuth | null): Promise<EmailSummary[]> {
  const auth = authOverride ?? getGoogleAuth();
  if (!auth) return [];

  const gmail = google.gmail({ version: "v1", auth });

  try {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: query,
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
      const getHeader = (name: string) => headers.find((h) => h.name === name)?.value ?? "";

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
    logger.error({ err, query }, "Failed to search emails");
    return [];
  }
}

/**
 * Forward an email (with attachments) to a recipient.
 */
export async function forwardEmail(
  messageId: string,
  to: string,
  additionalText?: string,
  authOverride?: GoogleAuth | null,
): Promise<boolean> {
  const auth = authOverride ?? getGoogleAuth();
  if (!auth) return false;

  const gmail = google.gmail({ version: "v1", auth });

  try {
    // Get the full message (including attachments)
    const msg = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "raw",
    });

    const headers = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date", "To"],
    });

    const getHeader = (name: string) =>
      headers.data.payload?.headers?.find((h) => h.name === name)?.value ?? "";

    const originalFrom = getHeader("From");
    const originalSubject = getHeader("Subject");
    const originalDate = getHeader("Date");
    const originalTo = getHeader("To");

    // Build forwarded message
    const fwdSubject = originalSubject.startsWith("Fwd:") ? originalSubject : `Fwd: ${originalSubject}`;

    // Get the original body for the forwarded text
    const bodyMsg = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

    const bodyText = extractPlainText(bodyMsg.data.payload) || msg.data.snippet || "";

    const forwardBody = [
      additionalText || "",
      "",
      "---------- Forwarded message ---------",
      `From: ${originalFrom}`,
      `Date: ${originalDate}`,
      `Subject: ${originalSubject}`,
      `To: ${originalTo}`,
      "",
      bodyText,
    ].join("\n");

    // Check for attachments
    const attachments = await getAttachments(gmail, messageId, bodyMsg.data.payload);

    if (attachments.length) {
      // Send as MIME multipart with attachments
      return await sendMimeWithAttachments(gmail, to, fwdSubject, forwardBody, attachments);
    }

    // Simple text forward
    return await sendEmail(to, fwdSubject, forwardBody, authOverride);
  } catch (err) {
    logger.error({ err, messageId, to }, "Failed to forward email");
    return false;
  }
}

/**
 * Reply to an email (maintains thread).
 */
export async function replyToEmail(
  messageId: string,
  body: string,
  replyAll = false,
  authOverride?: GoogleAuth | null,
): Promise<boolean> {
  const auth = authOverride ?? getGoogleAuth();
  if (!auth) return false;

  const gmail = google.gmail({ version: "v1", auth });

  try {
    const msg = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "To", "Cc", "Message-ID"],
    });

    const getHeader = (name: string) =>
      msg.data.payload?.headers?.find((h) => h.name === name)?.value ?? "";

    const from = getHeader("From");
    const subject = getHeader("Subject");
    const originalTo = getHeader("To");
    const cc = getHeader("Cc");
    const messageIdHeader = getHeader("Message-ID");
    const threadId = msg.data.threadId;

    const replySubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`;

    // For reply-all, include all original recipients
    let toField = from; // Reply to sender
    let ccField = "";
    if (replyAll) {
      const allRecipients = [originalTo, cc].filter(Boolean).join(", ");
      ccField = allRecipients;
    }

    const rawMessage = [
      `To: ${toField}`,
      ccField ? `Cc: ${ccField}` : null,
      `Subject: ${replySubject}`,
      `In-Reply-To: ${messageIdHeader}`,
      `References: ${messageIdHeader}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      body,
    ].filter(Boolean).join("\r\n");

    const encoded = Buffer.from(rawMessage)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: encoded, threadId: threadId ?? undefined },
    });

    logger.info({ messageId, to: toField, replyAll }, "Email reply sent");
    return true;
  } catch (err) {
    logger.error({ err, messageId }, "Failed to reply to email");
    return false;
  }
}

function extractPlainText(payload: any): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf-8");
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractPlainText(part);
      if (text) return text;
    }
  }
  return "";
}

interface Attachment {
  filename: string;
  mimeType: string;
  data: Buffer;
}

async function getAttachments(gmail: any, messageId: string, payload: any): Promise<Attachment[]> {
  const attachments: Attachment[] = [];
  if (!payload?.parts) return attachments;

  for (const part of payload.parts) {
    if (part.filename && part.body?.attachmentId) {
      try {
        const att = await gmail.users.messages.attachments.get({
          userId: "me",
          messageId,
          id: part.body.attachmentId,
        });
        attachments.push({
          filename: part.filename,
          mimeType: part.mimeType || "application/octet-stream",
          data: Buffer.from(att.data.data, "base64url"),
        });
      } catch {
        // skip failed attachments
      }
    }
  }
  return attachments;
}

async function sendMimeWithAttachments(
  gmail: any,
  to: string,
  subject: string,
  body: string,
  attachments: Attachment[],
): Promise<boolean> {
  const boundary = `boundary_${Date.now()}`;

  const parts = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ];

  for (const att of attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${att.mimeType}; name="${att.filename}"`,
      `Content-Disposition: attachment; filename="${att.filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      att.data.toString("base64"),
    );
  }

  parts.push(`--${boundary}--`);

  const rawMessage = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    parts.join("\r\n"),
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
    logger.info({ to, subject, attachments: attachments.length }, "Email with attachments sent");
    return true;
  } catch (err) {
    logger.error({ err, to, subject }, "Failed to send email with attachments");
    return false;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
