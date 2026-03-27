import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../models/database.js";
import { messageLogs, tasks } from "../models/schema.js";
import { searchDriveFiles } from "./drive-manager.js";
import { searchNotion, isNotionConfigured } from "./notion-sync.js";
import { queryKnowledge } from "./knowledge-base.js";
import type { GoogleAuth } from "../core/google-auth.js";
import { logger } from "../utils/logger.js";

export interface SearchResult {
  source: string;
  title: string;
  snippet: string;
  url?: string;
  date?: string;
}

/**
 * Search across all integrated tools in parallel.
 */
export async function unifiedSearch(
  query: string,
  options?: { source?: string; maxResults?: number; authOverride?: GoogleAuth | null },
): Promise<SearchResult[]> {
  const max = options?.maxResults ?? 5;
  const source = options?.source;
  const results: SearchResult[] = [];

  const searches: Promise<void>[] = [];

  // Drive search
  if (!source || source === "drive") {
    searches.push(
      searchDriveFiles(query, max, options?.authOverride).then((files) => {
        for (const f of files) {
          results.push({
            source: "drive",
            title: f.name,
            snippet: `${f.mimeType} — ${f.createdTime ? new Date(f.createdTime).toLocaleDateString("it-IT") : ""}`,
            url: f.webViewLink,
            date: f.createdTime,
          });
        }
      }).catch(() => {}),
    );
  }

  // Notion search
  if ((!source || source === "notion") && isNotionConfigured()) {
    searches.push(
      searchNotion(query).then((items) => {
        for (const item of items.slice(0, max)) {
          results.push({
            source: "notion",
            title: item.title,
            snippet: `${item.type}`,
            url: item.url,
          });
        }
      }).catch(() => {}),
    );
  }

  // Task search
  if (!source || source === "tasks") {
    searches.push(
      db.select({ id: tasks.id, title: tasks.title, status: tasks.status, priority: tasks.priority, dueDate: tasks.dueDate })
        .from(tasks)
        .where(sql`(${tasks.title} ILIKE ${"%" + query + "%"} OR ${tasks.description} ILIKE ${"%" + query + "%"})`)
        .limit(max)
        .then((rows) => {
          for (const t of rows) {
            results.push({
              source: "tasks",
              title: t.title,
              snippet: `${t.status} | ${t.priority}${t.dueDate ? ` | scade ${new Date(t.dueDate).toLocaleDateString("it-IT")}` : ""}`,
            });
          }
        }).catch(() => {}),
    );
  }

  // Message log search (Slack + Telegram + Gmail)
  if (!source || source === "slack" || source === "messages") {
    searches.push(
      db.select({
        chatTitle: messageLogs.chatTitle,
        senderName: messageLogs.senderName,
        content: messageLogs.content,
        source: messageLogs.source,
        receivedAt: messageLogs.receivedAt,
      })
        .from(messageLogs)
        .where(sql`(${messageLogs.content} ILIKE ${"%" + query + "%"} OR ${messageLogs.fullContent} ILIKE ${"%" + query + "%"})`)
        .orderBy(sql`${messageLogs.receivedAt} DESC`)
        .limit(max)
        .then((rows) => {
          for (const m of rows) {
            results.push({
              source: m.source ?? "message",
              title: `${m.senderName} in ${m.chatTitle}`,
              snippet: m.content.slice(0, 150),
              date: m.receivedAt?.toISOString(),
            });
          }
        }).catch(() => {}),
    );
  }

  // Knowledge base search
  if (!source || source === "knowledge") {
    searches.push(
      queryKnowledge(query).then((text) => {
        if (text && !text.includes("Nessun") && text.length > 20) {
          results.push({
            source: "knowledge",
            title: "Knowledge Base",
            snippet: text.slice(0, 300),
          });
        }
      }).catch(() => {}),
    );
  }

  await Promise.allSettled(searches);

  // Sort by date (most recent first) and deduplicate
  results.sort((a, b) => {
    if (a.date && b.date) return new Date(b.date).getTime() - new Date(a.date).getTime();
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
  });

  return results;
}
