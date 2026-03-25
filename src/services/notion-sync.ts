import { Client } from "@notionhq/client";
import type { Bot } from "grammy";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

// --- Types ---

export interface NotionTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  assignee: string | null;
  dueDate: string | null;
  url: string;
  isOverdue: boolean;
}

export interface NotionProject {
  id: string;
  name: string;
  status: string;
  owner: string | null;
  url: string;
}

export interface NotionWorkspaceSummary {
  tasks: NotionTask[];
  projects: NotionProject[];
  lastSynced: string;
}

// --- Guard ---

export function isNotionConfigured(): boolean {
  return !!config.NOTION_API_KEY;
}

// --- Cache ---

let _cachedData: NotionWorkspaceSummary | null = null;
let _cacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

// --- Notion Client (lazy init) ---

let _client: Client | null = null;
function getClient(): Client {
  if (!_client) {
    _client = new Client({ auth: config.NOTION_API_KEY });
  }
  return _client;
}

// --- Property Helpers (work with any property shape) ---

function extractTitle(props: Record<string, any>): string {
  for (const prop of Object.values(props)) {
    if (prop.type === "title" && prop.title?.length > 0) {
      return prop.title.map((t: any) => t.plain_text).join("");
    }
  }
  return "Untitled";
}

function extractSelect(props: Record<string, any>, ...names: string[]): string {
  for (const name of names) {
    const prop = props[name];
    if (prop?.type === "select" && prop.select) return prop.select.name;
    if (prop?.type === "status" && prop.status) return prop.status.name;
  }
  return "";
}

function extractPerson(props: Record<string, any>, ...names: string[]): string | null {
  for (const name of names) {
    const prop = props[name];
    if (prop?.type === "people" && prop.people?.length > 0) {
      const p = prop.people[0];
      return p.name ?? null;
    }
  }
  return null;
}

function extractDate(props: Record<string, any>, ...names: string[]): string | null {
  for (const name of names) {
    const prop = props[name];
    if (prop?.type === "date" && prop.date) {
      return prop.date.start;
    }
  }
  return null;
}

// --- Core Functions ---

export async function getNotionTasks(): Promise<NotionTask[]> {
  if (!config.NOTION_TASKS_DATABASE_ID) return [];

  const client = getClient();
  const now = new Date();

  try {
    const response = await client.dataSources.query({
      data_source_id: config.NOTION_TASKS_DATABASE_ID,
      page_size: 100,
    });

    return response.results
      .filter((p: any) => p.properties)
      .map((page: any) => {
        const props = page.properties;
        const dueDate = extractDate(props, "Due date", "Due Date", "Due", "Deadline", "Date");
        return {
          id: page.id,
          title: extractTitle(props),
          status: extractSelect(props, "Status", "State"),
          priority: extractSelect(props, "Priority", "Priorita"),
          assignee: extractPerson(props, "Assignee", "Assign", "Person", "Owner"),
          dueDate,
          url: page.url ?? "",
          isOverdue: dueDate ? new Date(dueDate) < now : false,
        };
      });
  } catch (err) {
    logger.error({ err }, "Failed to fetch Notion tasks");
    return [];
  }
}

export async function getNotionProjects(): Promise<NotionProject[]> {
  if (!config.NOTION_PROJECTS_DATABASE_ID) return [];

  const client = getClient();

  try {
    const response = await client.dataSources.query({
      data_source_id: config.NOTION_PROJECTS_DATABASE_ID,
      page_size: 100,
    });

    return response.results
      .filter((p: any) => p.properties)
      .map((page: any) => {
        const props = page.properties;
        return {
          id: page.id,
          name: extractTitle(props),
          status: extractSelect(props, "Status", "State", "Phase"),
          owner: extractPerson(props, "Owner", "Lead", "Person", "Assignee"),
          url: page.url ?? "",
        };
      });
  } catch (err) {
    logger.error({ err }, "Failed to fetch Notion projects");
    return [];
  }
}

export async function getNotionWorkspaceSummary(): Promise<NotionWorkspaceSummary> {
  if (Date.now() - _cacheTime < CACHE_TTL_MS && _cachedData) {
    return _cachedData;
  }

  const [tasks, projects] = await Promise.all([
    getNotionTasks(),
    getNotionProjects(),
  ]);

  const data: NotionWorkspaceSummary = {
    tasks,
    projects,
    lastSynced: new Date().toISOString(),
  };

  _cachedData = data;
  _cacheTime = Date.now();
  return data;
}

export async function searchNotion(query: string): Promise<Array<{ title: string; type: string; url: string }>> {
  if (!isNotionConfigured()) return [];

  const client = getClient();
  try {
    const response = await client.search({ query, page_size: 10 });
    return response.results
      .filter((r: any) => r.url)
      .map((r: any) => ({
        title: r.properties ? extractTitle(r.properties) : (r.title?.[0]?.plain_text ?? "Untitled"),
        type: r.object,
        url: r.url,
      }));
  } catch (err) {
    logger.error({ err }, "Notion search failed");
    return [];
  }
}

export async function createNotionTask(
  title: string,
  props?: { status?: string; priority?: string; dueDate?: string },
): Promise<string | null> {
  if (!config.NOTION_TASKS_DATABASE_ID) return null;

  const client = getClient();

  try {
    // Discover schema to find the title property name
    const dbInfo = await client.dataSources.retrieve({
      data_source_id: config.NOTION_TASKS_DATABASE_ID,
    }) as any;

    let titlePropName = "Name";
    if (dbInfo.properties) {
      for (const [name, prop] of Object.entries(dbInfo.properties) as [string, any][]) {
        if (prop.type === "title") {
          titlePropName = name;
          break;
        }
      }
    }

    const properties: Record<string, any> = {
      [titlePropName]: { title: [{ text: { content: title } }] },
    };

    if (props?.status && dbInfo.properties?.["Status"]) {
      const statusProp = dbInfo.properties["Status"] as any;
      if (statusProp.type === "select") {
        properties["Status"] = { select: { name: props.status } };
      } else if (statusProp.type === "status") {
        properties["Status"] = { status: { name: props.status } };
      }
    }

    if (props?.priority && (dbInfo.properties?.["Priority"] as any)?.type === "select") {
      properties["Priority"] = { select: { name: props.priority } };
    }

    if (props?.dueDate && dbInfo.properties) {
      const datePropName = ["Due date", "Due Date", "Due", "Deadline", "Date"].find(
        (n) => (dbInfo.properties[n] as any)?.type === "date",
      );
      if (datePropName) {
        properties[datePropName] = { date: { start: props.dueDate } };
      }
    }

    const page = await client.pages.create({
      parent: { database_id: config.NOTION_TASKS_DATABASE_ID },
      properties,
    }) as any;

    return page.url ?? null;
  } catch (err) {
    logger.error({ err, title }, "Failed to create Notion task");
    return null;
  }
}

// --- Scheduled Job ---

export async function syncNotionData(bot: Bot): Promise<void> {
  if (!isNotionConfigured()) {
    logger.debug("Notion sync skipped — not configured");
    return;
  }

  const data = await getNotionWorkspaceSummary();

  const overdueTasks = data.tasks.filter((t) => t.isOverdue);
  if (overdueTasks.length) {
    const lines = overdueTasks.map((t) => {
      const assignee = t.assignee ?? "unassigned";
      const due = t.dueDate ? new Date(t.dueDate).toLocaleDateString("it-IT") : "";
      return `- <b>${t.title}</b> (${t.status}) \u2014 ${assignee} \u2014 due ${due}`;
    });

    const msg =
      `\u26A0\uFE0F <b>Notion: ${overdueTasks.length} overdue task(s)</b>\n\n` +
      lines.join("\n");

    try {
      await bot.api.sendMessage(config.TELEGRAM_OWNER_CHAT_ID, msg, { parse_mode: "HTML" });
    } catch (err) {
      logger.error({ err }, "Failed to send Notion overdue notification");
    }
  }

  logger.info(
    { tasks: data.tasks.length, projects: data.projects.length },
    "Notion sync complete",
  );
}
