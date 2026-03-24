import { google } from "googleapis";
import type { Bot } from "grammy";
import { config } from "../config.js";
import { getGoogleAuth, isGoogleConfigured } from "../core/google-auth.js";
import { logger } from "../utils/logger.js";

// --- Types ---

export interface KanbanchiCard {
  id: string;
  title: string;
  description: string;
  columnName: string;
  assignees: string[];
  dueDate: string | null;
  startDate: string | null;
  priority: string;
  isOverdue: boolean;
  created: number;
}

export interface KanbanchiColumn {
  id: string;
  name: string;
  orderNumber: number;
}

export interface KanbanchiBoard {
  name: string;
  columns: KanbanchiColumn[];
  cards: KanbanchiCard[];
  lastSynced: string;
}

// --- Cache ---

let _cachedBoards: KanbanchiBoard[] = [];
let _cacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

// --- Core Functions ---

export async function getKanbanchiBoards(): Promise<KanbanchiBoard[]> {
  if (Date.now() - _cacheTime < CACHE_TTL_MS && _cachedBoards.length) {
    return _cachedBoards;
  }

  if (!isGoogleConfigured()) return [];

  const auth = getGoogleAuth();
  if (!auth) return [];

  const drive = google.drive({ version: "v3", auth });

  try {
    // Find Kanbanchi root folder
    const folderId = await findKanchiFolderId(drive);
    if (!folderId) { logger.debug("Kanbanchi: root folder not found"); return []; }
    logger.debug({ folderId }, "Kanbanchi: root folder found");

    // List board folders
    const boardFolders = await listBoardFolders(drive, folderId);
    logger.debug({ count: boardFolders.length, names: boardFolders.map((f) => f.name) }, "Kanbanchi: board folders found");
    const boards: KanbanchiBoard[] = [];

    for (const folder of boardFolders) {
      // Filter by board name if configured
      if (config.KANBANCHI_BOARD_NAME && folder.name !== config.KANBANCHI_BOARD_NAME) {
        continue;
      }

      const board = await readBoardBackup(drive, folder.id, folder.name);
      if (board) {
        logger.info({ board: board.name, cards: board.cards.length, columns: board.columns.length }, "Kanbanchi board loaded");
        boards.push(board);
      }
    }

    _cachedBoards = boards;
    _cacheTime = Date.now();
    return boards;
  } catch (err: any) {
    if (err.code === 403) {
      logger.warn("Drive access denied — re-run 'npm run google:auth' to grant drive.readonly scope");
    } else {
      logger.error({ err }, "Failed to fetch Kanbanchi boards");
    }
    return [];
  }
}

async function findKanchiFolderId(drive: any): Promise<string | null> {
  if (config.KANBANCHI_FOLDER_ID) return config.KANBANCHI_FOLDER_ID;

  const res = await drive.files.list({
    q: "name = 'Kanbanchi' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
    fields: "files(id, name)",
  });

  const folder = res.data.files?.[0];
  if (!folder) {
    logger.debug("Kanbanchi folder not found in Google Drive");
    return null;
  }
  return folder.id;
}

async function listBoardFolders(
  drive: any,
  rootFolderId: string,
): Promise<{ id: string; name: string }[]> {
  const res = await drive.files.list({
    q: `'${rootFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id, name, modifiedTime)",
    orderBy: "modifiedTime desc",
    pageSize: 20,
  });

  return (res.data.files ?? []).map((f: any) => ({ id: f.id, name: f.name }));
}

async function readBoardBackup(
  drive: any,
  boardFolderId: string,
  boardName: string,
): Promise<KanbanchiBoard | null> {
  // Find the _backup folder
  const backupRes = await drive.files.list({
    q: `'${boardFolderId}' in parents and name contains '_backup' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id, name)",
  });

  const backupFolder = backupRes.data.files?.[0];
  if (!backupFolder) {
    logger.debug({ boardName }, "No backup folder found for board");
    return null;
  }

  // Get the latest backup file (XML)
  const filesRes = await drive.files.list({
    q: `'${backupFolder.id}' in parents and trashed = false`,
    fields: "files(id, name, mimeType, modifiedTime)",
    orderBy: "modifiedTime desc",
    pageSize: 1,
  });

  const backupFile = filesRes.data.files?.[0];
  if (!backupFile) {
    logger.debug({ boardName }, "No backup files found");
    return null;
  }

  // Download the backup XML
  const dlRes = await drive.files.get(
    { fileId: backupFile.id, alt: "media" },
    { responseType: "text" },
  );

  const xml = typeof dlRes.data === "string" ? dlRes.data : String(dlRes.data);
  return parseKanbanchiXml(xml, boardName);
}

// --- XML Parser ---

function parseKanbanchiXml(xml: string, boardName: string): KanbanchiBoard | null {
  try {
    // Parse lists/columns
    const columns: KanbanchiColumn[] = [];
    const listRegex = /<list>([\s\S]*?)<\/list>/g;
    let listMatch;
    while ((listMatch = listRegex.exec(xml)) !== null) {
      const block = listMatch[1];
      columns.push({
        id: extractTag(block, "id"),
        name: extractCdata(block, "name"),
        orderNumber: parseFloat(extractTag(block, "orderNumber")) || 0,
      });
    }
    columns.sort((a, b) => a.orderNumber - b.orderNumber);

    const columnMap = new Map(columns.map((c) => [c.id, c.name]));

    // Parse cards
    const cards: KanbanchiCard[] = [];
    const cardRegex = /<card>([\s\S]*?)<\/card>/g;
    let cardMatch;
    const now = Date.now();

    while ((cardMatch = cardRegex.exec(xml)) !== null) {
      const block = cardMatch[1];
      const listId = extractTag(block, "listId");
      const dueDateRaw = extractTag(block, "dueDate");
      const dueDate = dueDateRaw ? new Date(Number(dueDateRaw)).toISOString() : null;
      const startDateRaw = extractTag(block, "startDate");
      const startDate = startDateRaw ? new Date(Number(startDateRaw)).toISOString() : null;

      // Parse assignees
      const assigneesRaw = extractCdata(block, "assigneesJson");
      let assignees: string[] = [];
      try {
        const parsed = JSON.parse(assigneesRaw);
        if (Array.isArray(parsed)) {
          assignees = parsed.map((a: any) =>
            typeof a === "string" ? a : a.fullName || a.email || "Unknown",
          );
        }
      } catch { /* empty */ }

      cards.push({
        id: extractTag(block, "cardId"),
        title: extractCdata(block, "title"),
        description: extractCdata(block, "description"),
        columnName: columnMap.get(listId) ?? "Unknown",
        assignees,
        dueDate,
        startDate,
        priority: extractCdata(block, "priority") || "0",
        isOverdue: dueDate ? new Date(dueDate).getTime() < now : false,
        created: parseInt(extractTag(block, "created")) || 0,
      });
    }

    return {
      name: boardName,
      columns,
      cards,
      lastSynced: new Date().toISOString(),
    };
  } catch (err) {
    logger.error({ err, boardName, xmlSample: xml.slice(0, 200) }, "Failed to parse Kanbanchi XML");
    return null;
  }
}

function extractTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return match?.[1]?.trim() ?? "";
}

function extractCdata(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`));
  if (match) return match[1];
  return extractTag(block, tag);
}

// --- Scheduled Job ---

export async function syncKanbanchiBoard(bot: Bot): Promise<void> {
  if (!isGoogleConfigured()) {
    logger.debug("Kanbanchi sync skipped — Google not configured");
    return;
  }

  const boards = await getKanbanchiBoards();
  if (!boards.length) return;

  const overdueCards = boards.flatMap((b) =>
    b.cards.filter((c) => c.isOverdue).map((c) => ({ ...c, boardName: b.name })),
  );

  if (overdueCards.length) {
    const lines = overdueCards.map((c) => {
      const assignee = c.assignees.length ? c.assignees.join(", ") : "unassigned";
      const due = c.dueDate ? new Date(c.dueDate).toLocaleDateString("it-IT") : "";
      return `• <b>${c.title}</b> (${c.boardName} → ${c.columnName}) — ${assignee} — due ${due}`;
    });

    const msg =
      `\u26A0\uFE0F <b>Kanbanchi: ${overdueCards.length} overdue card(s)</b>\n\n` +
      lines.join("\n");

    try {
      await bot.api.sendMessage(config.TELEGRAM_OWNER_CHAT_ID, msg, { parse_mode: "HTML" });
    } catch (err) {
      logger.error({ err }, "Failed to send Kanbanchi overdue notification");
    }
  }

  logger.info(
    { boards: boards.length, totalCards: boards.reduce((n, b) => n + b.cards.length, 0) },
    "Kanbanchi sync complete",
  );
}
