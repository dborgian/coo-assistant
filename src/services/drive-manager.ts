import { google } from "googleapis";
import { Readable } from "node:stream";
import { config } from "../config.js";
import { getGoogleAuth, isGoogleConfigured } from "../core/google-auth.js";
import type { GoogleAuth } from "../core/google-auth.js";
import { logger } from "../utils/logger.js";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  webViewLink: string;
  createdTime: string;
  size: string;
}

function getDrive(authOverride?: GoogleAuth | null) {
  const auth = authOverride ?? getGoogleAuth();
  if (!auth) return null;
  return google.drive({ version: "v3", auth });
}

export async function uploadFileToDrive(
  fileName: string,
  content: Buffer,
  mimeType: string,
  folderId?: string,
): Promise<DriveFile | null> {
  const targetFolder = folderId || config.COO_DRIVE_FOLDER_ID;
  if (!isGoogleConfigured() || !targetFolder) {
    logger.debug("Drive upload skipped - not configured");
    return null;
  }

  const drive = getDrive();
  if (!drive) return null;

  try {
    logger.info({ fileName, folderId: targetFolder, size: content.length }, "Uploading to Drive");

    const res = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [targetFolder],
      },
      media: {
        mimeType,
        body: Readable.from(content),
      },
      fields: "id, name, mimeType, webViewLink, createdTime, size",
      supportsAllDrives: true,
    });

    const file = res.data;
    logger.info({ fileId: file.id, name: fileName, link: file.webViewLink }, "File uploaded to Drive");

    return {
      id: file.id!,
      name: file.name!,
      mimeType: file.mimeType!,
      webViewLink: file.webViewLink!,
      createdTime: file.createdTime!,
      size: file.size ?? "0",
    };
  } catch (err: any) {
    logger.error({ err, fileName, folderId: config.COO_DRIVE_FOLDER_ID, code: err?.code }, "Failed to upload file to Drive");
    return null;
  }
}

export async function listDriveFiles(maxResults = 10, authOverride?: GoogleAuth | null): Promise<DriveFile[]> {
  if (!isGoogleConfigured() || !config.COO_DRIVE_FOLDER_ID) return [];

  const drive = getDrive(authOverride);
  if (!drive) return [];

  try {
    const res = await drive.files.list({
      q: `'${config.COO_DRIVE_FOLDER_ID}' in parents and trashed = false`,
      fields: "files(id, name, mimeType, webViewLink, createdTime, size)",
      orderBy: "createdTime desc",
      pageSize: maxResults,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    return (res.data.files ?? []).map((f) => ({
      id: f.id!,
      name: f.name!,
      mimeType: f.mimeType ?? "",
      webViewLink: f.webViewLink ?? "",
      createdTime: f.createdTime ?? "",
      size: f.size ?? "0",
    }));
  } catch (err) {
    logger.error({ err }, "Failed to list Drive files");
    return [];
  }
}

export async function searchDriveFiles(query: string, maxResults = 10, authOverride?: GoogleAuth | null): Promise<DriveFile[]> {
  if (!isGoogleConfigured() || !config.COO_DRIVE_FOLDER_ID) return [];

  const drive = getDrive(authOverride);
  if (!drive) return [];

  try {
    const res = await drive.files.list({
      q: `'${config.COO_DRIVE_FOLDER_ID}' in parents and trashed = false and name contains '${query.replace(/'/g, "\\'")}'`,
      fields: "files(id, name, mimeType, webViewLink, createdTime, size)",
      orderBy: "createdTime desc",
      pageSize: maxResults,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    return (res.data.files ?? []).map((f) => ({
      id: f.id!,
      name: f.name!,
      mimeType: f.mimeType ?? "",
      webViewLink: f.webViewLink ?? "",
      createdTime: f.createdTime ?? "",
      size: f.size ?? "0",
    }));
  } catch (err) {
    logger.error({ err, query }, "Failed to search Drive files");
    return [];
  }
}
