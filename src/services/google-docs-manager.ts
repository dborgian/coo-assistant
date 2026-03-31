import { google } from "googleapis";
import { config } from "../config.js";
import { getGoogleAuth } from "../core/google-auth.js";
import type { GoogleAuth } from "../core/google-auth.js";
import { logger } from "../utils/logger.js";

export interface CreatedDoc {
  id: string;
  title: string;
  url: string;
}

/**
 * Create a Google Doc with text content.
 */
export async function createGoogleDoc(
  title: string,
  content: string,
  folderId?: string,
  authOverride?: GoogleAuth | null,
): Promise<CreatedDoc | null> {
  const auth = authOverride ?? getGoogleAuth();
  if (!auth) return null;

  const drive = google.drive({ version: "v3", auth });
  const docs = google.docs({ version: "v1", auth });

  try {
    // Create blank doc in Drive
    const file = await drive.files.create({
      requestBody: {
        name: title,
        mimeType: "application/vnd.google-apps.document",
        ...(folderId ? { parents: [folderId] } : config.COO_DRIVE_FOLDER_ID ? { parents: [config.COO_DRIVE_FOLDER_ID] } : {}),
      },
      fields: "id, name, webViewLink",
    });

    const docId = file.data.id!;

    // Insert content
    if (content.trim()) {
      await docs.documents.batchUpdate({
        documentId: docId,
        requestBody: {
          requests: [
            {
              insertText: {
                location: { index: 1 },
                text: content,
              },
            },
          ],
        },
      });
    }

    const result: CreatedDoc = {
      id: docId,
      title: file.data.name!,
      url: file.data.webViewLink ?? `https://docs.google.com/document/d/${docId}/edit`,
    };

    logger.info({ docId, title }, "Google Doc created");
    return result;
  } catch (err) {
    logger.error({ err, title }, "Failed to create Google Doc");
    return null;
  }
}

/**
 * Read plain text content from an existing Google Doc via Drive export API.
 * Uses drive scope (already in token) — more reliable than Docs API.
 */
export async function readGoogleDocText(docId: string, authOverride?: GoogleAuth | null): Promise<string | null> {
  const auth = authOverride ?? getGoogleAuth();
  if (!auth) return null;

  try {
    const drive = google.drive({ version: "v3", auth });
    const res = await drive.files.export(
      { fileId: docId, mimeType: "text/plain" },
      { responseType: "text" },
    );
    const text = typeof res.data === "string" ? res.data : String(res.data ?? "");
    return text.trim() || null;
  } catch (err) {
    logger.error({ err, docId }, "Failed to read Google Doc via Drive export");
    return null;
  }
}

/**
 * Create a structured meeting notes document.
 */
export async function createMeetingDoc(
  meetingTitle: string,
  date: string,
  summary: string,
  decisions: string[],
  actionItems: string[],
  authOverride?: GoogleAuth | null,
): Promise<CreatedDoc | null> {
  const content = [
    `MEETING NOTES: ${meetingTitle}`,
    `Data: ${date}`,
    "",
    "SUMMARY",
    summary,
    "",
    "DECISIONI",
    ...decisions.map((d, i) => `${i + 1}. ${d}`),
    "",
    "ACTION ITEMS",
    ...actionItems.map((a, i) => `${i + 1}. ${a}`),
    "",
    `Generato automaticamente da COO Assistant — ${new Date().toLocaleString("it-IT")}`,
  ].join("\n");

  return createGoogleDoc(`Meeting Notes — ${meetingTitle} (${date})`, content, undefined, authOverride);
}
