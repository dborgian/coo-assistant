import { Client } from "@notionhq/client";
import { ilike, eq } from "drizzle-orm";
import { config } from "../config.js";
import { sendOwnerNotification } from "../utils/notify.js";
import { logger } from "../utils/logger.js";
import { db } from "../models/database.js";
import { employees } from "../models/schema.js";

/**
 * Convert "YYYY-MM-DDTHH:mm[:ss]" (local time) to "YYYY-MM-DDTHH:mm:ss+HH:MM" for Notion API.
 * Notion needs an explicit timezone offset to display the correct time; without it, times are
 * treated as UTC and shown in the user's Notion account timezone (which may differ from Italy).
 */
function toNotionDatetime(dateStr: string): string {
  if (!dateStr.includes("T")) return dateStr; // date-only — no change needed
  const tz = config.TIMEZONE || "Europe/Rome";
  // Normalize to include seconds
  const normalized = dateStr.split(":").length === 2 ? dateStr + ":00" : dateStr;
  const [datePart, timePart] = normalized.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);
  // Use the actual date to find the correct DST offset
  const refDate = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" });
  const match = fmt.format(refDate).match(/GMT([+-])(\d+)(?::(\d+))?/);
  if (!match) return normalized;
  const sign = match[1];
  const hh = match[2].padStart(2, "0");
  const mm = (match[3] ?? "00").padStart(2, "0");
  return `${normalized}${sign}${hh}:${mm}`;
}

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

// --- Helpers ---

/** Extracts the Notion page ID (UUID or 32-char hex) from a Notion URL. */
export function extractNotionPageId(url: string): string | null {
  return (
    url.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/)?.[0]
    ?? url.match(/([a-f0-9]{32})/)?.[1]
    ?? url.split("/").pop()?.split("-").pop()
    ?? null
  );
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

// --- User Discovery ---

export async function discoverNotionUsers(): Promise<void> {
  if (!isNotionConfigured()) return;
  const client = getClient();
  try {
    const response = await client.users.list({});
    const allEmployees = await db.select().from(employees);
    let linked = 0;

    for (const user of response.results) {
      if (user.type !== "person" || !user.name) continue;
      const email = (user as any).person?.email as string | undefined;
      const match = allEmployees.find(
        (e) =>
          e.name?.toLowerCase() === user.name!.toLowerCase() ||
          (email && e.email?.toLowerCase() === email.toLowerCase()),
      );
      if (match && !match.notionUserId) {
        await db.update(employees)
          .set({ notionUserId: user.id, notionUserName: user.name })
          .where(eq(employees.id, match.id));
        logger.info({ employee: match.name, notionId: user.id }, "Notion user linked");
        linked++;
      }
    }
    logger.info({ linked, total: response.results.length }, "Notion user discovery complete");
  } catch (err) {
    logger.warn({ err }, "Notion user discovery failed");
  }
}

// --- Helper: resolve employee name → Notion user ID ---

async function resolveNotionUserId(name: string): Promise<string | null> {
  const emp = await db.select().from(employees)
    .where(ilike(employees.name, `%${name}%`))
    .limit(1);
  return emp[0]?.notionUserId ?? null;
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
    getNotionTasksViaSearch(),
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
  props?: { status?: string; priority?: string; dueDate?: string; assignee?: string; description?: string },
): Promise<string | null> {
  if (!config.NOTION_TASKS_DATABASE_ID) return null;

  const client = getClient();

  try {
    // Try to discover schema; fall back to common title property names
    let titlePropName = "Task name";
    let dbInfo: any = null;

    try {
      dbInfo = await client.databases.retrieve({ database_id: config.NOTION_TASKS_DATABASE_ID }) as any;
      if (dbInfo?.properties) {
        for (const [name, prop] of Object.entries(dbInfo.properties) as [string, any][]) {
          if (prop.type === "title") {
            titlePropName = name;
            break;
          }
        }
      }
    } catch {
      // Database may not expose properties (template-style); use default
    }

    const properties: Record<string, any> = {
      [titlePropName]: { title: [{ text: { content: title } }] },
    };

    // Try to set Status, Priority, Due Date — silently skip if property doesn't exist
    if (props?.status) {
      if (dbInfo?.properties?.["Status"]) {
        const statusProp = dbInfo.properties["Status"] as any;
        if (statusProp.type === "select") {
          properties["Status"] = { select: { name: props.status } };
        } else if (statusProp.type === "status") {
          properties["Status"] = { status: { name: props.status } };
        }
      } else {
        // Try status type as default for template databases
        properties["Status"] = { status: { name: props.status } };
      }
    }

    if (props?.priority) {
      properties["Priority"] = { select: { name: props.priority } };
    }

    if (props?.dueDate) {
      // Try common date property names
      const datePropName = dbInfo?.properties
        ? (["Due date", "Due Date", "Due", "Deadline", "Date"].find(
            (n) => (dbInfo.properties[n] as any)?.type === "date",
          ) ?? "Due date")
        : "Due date";
      properties[datePropName] = { date: { start: toNotionDatetime(props.dueDate) } };
    }

    if (props?.assignee) {
      const notionUserId = await resolveNotionUserId(props.assignee);
      if (notionUserId) {
        // Discover assignee property name
        const assigneePropName = dbInfo?.properties
          ? (["Assignee", "Assign", "Person", "Owner"].find(
              (n) => (dbInfo.properties[n] as any)?.type === "people",
            ) ?? "Assignee")
          : "Assignee";
        properties[assigneePropName] = { people: [{ id: notionUserId }] };
      }
    }

    const page = await client.pages.create({
      parent: { database_id: config.NOTION_TASKS_DATABASE_ID },
      properties,
    }) as any;

    // Add description as page body if provided
    if (props?.description && page.id) {
      await client.blocks.children.append({
        block_id: page.id,
        children: [{ paragraph: { rich_text: [{ text: { content: props.description } }] } }] as any,
      }).catch((e: unknown) => logger.warn({ err: e, pageId: page.id }, "Failed to append description block to Notion page"));
    }

    return page.url ?? null;
  } catch (err) {
    logger.error({ err, title }, "Failed to create Notion task");
    return null;
  }
}

export async function updateNotionTaskStatus(
  notionPageId: string,
  status: string,
): Promise<boolean> {
  const client = getClient();
  try {
    const statusMap: Record<string, string> = {
      done: "Done",
      cancelled: "Done",
      in_progress: "In progress",
      pending: "Not started",
      not_started: "Not started",
    };
    // Normalize: "in progress" → "in_progress", "In Progress" → "in_progress"
    const normalized = status.toLowerCase().replace(/\s+/g, "_");
    const notionStatus = statusMap[normalized] ?? status;

    // Discover Status property type (select vs status)
    let statusType: "status" | "select" = "status";
    if (config.NOTION_TASKS_DATABASE_ID) {
      try {
        const dbInfo = await client.databases.retrieve({ database_id: config.NOTION_TASKS_DATABASE_ID }) as any;
        if (dbInfo?.properties?.["Status"]?.type === "select") statusType = "select";
      } catch {
        // fall back to status type
      }
    }

    await client.pages.update({
      page_id: notionPageId,
      properties: {
        Status: statusType === "select"
          ? { select: { name: notionStatus } }
          : { status: { name: notionStatus } },
      },
    });
    return true;
  } catch (err) {
    logger.error({ err, notionPageId, status }, "Failed to update Notion task status");
    return false;
  }
}

export async function archiveNotionPage(notionPageId: string): Promise<boolean> {
  const client = getClient();
  try {
    await client.pages.update({
      page_id: notionPageId,
      archived: true,
    });
    return true;
  } catch (err) {
    logger.error({ err, notionPageId }, "Failed to archive Notion page");
    return false;
  }
}

export async function updateNotionTaskProperties(
  notionPageId: string,
  updates: { priority?: string; dueDate?: string; description?: string; assignee?: string },
): Promise<boolean> {
  const client = getClient();
  try {
    const properties: Record<string, any> = {};

    // Discover schema for flexible property name resolution
    let dbInfo: any = null;
    if (config.NOTION_TASKS_DATABASE_ID && (updates.dueDate || updates.assignee)) {
      try {
        dbInfo = await client.databases.retrieve({ database_id: config.NOTION_TASKS_DATABASE_ID }) as any;
      } catch {
        // ignore — fall back to hardcoded names
      }
    }

    if (updates.priority) {
      properties["Priority"] = { select: { name: updates.priority } };
    }
    if (updates.dueDate) {
      const datePropName = dbInfo?.properties
        ? (["Due date", "Due Date", "Due", "Deadline", "Date"].find(
            (n) => (dbInfo.properties[n] as any)?.type === "date",
          ) ?? "Due date")
        : "Due date";
      properties[datePropName] = { date: { start: toNotionDatetime(updates.dueDate) } };
    }
    if (updates.assignee) {
      const notionUserId = await resolveNotionUserId(updates.assignee);
      if (notionUserId) {
        const assigneePropName = dbInfo?.properties
          ? (["Assignee", "Assign", "Person", "Owner"].find(
              (n) => (dbInfo.properties[n] as any)?.type === "people",
            ) ?? "Assignee")
          : "Assignee";
        properties[assigneePropName] = { people: [{ id: notionUserId }] };
      }
    }

    if (Object.keys(properties).length) {
      await client.pages.update({ page_id: notionPageId, properties });
    }

    // Update page body (description) if provided
    if (updates.description) {
      await client.pages.updateMarkdown({
        page_id: notionPageId,
        markdown: updates.description,
      } as any).catch(() => {
        // Fallback: add as a paragraph block
        return (client as any).blocks?.children?.append?.({
          block_id: notionPageId,
          children: [{ paragraph: { rich_text: [{ text: { content: updates.description! } }] } }],
        });
      });
    }

    return true;
  } catch (err) {
    logger.error({ err, notionPageId }, "Failed to update Notion task properties");
    return false;
  }
}

export async function addNotionComment(
  notionPageId: string,
  comment: string,
): Promise<boolean> {
  const client = getClient();
  try {
    await (client as any).comments.create({
      parent: { page_id: notionPageId },
      rich_text: [{ text: { content: comment } }],
    });
    return true;
  } catch (err) {
    logger.error({ err, notionPageId }, "Failed to add Notion comment");
    return false;
  }
}

export async function createNotionProject(
  name: string,
  props?: { status?: string; owner?: string },
): Promise<string | null> {
  if (!config.NOTION_PROJECTS_DATABASE_ID) return null;

  const client = getClient();
  try {
    const properties: Record<string, any> = {
      Name: { title: [{ text: { content: name } }] },
    };
    if (props?.status) {
      properties["Status"] = { select: { name: props.status } };
    }
    if (props?.owner) {
      const notionUserId = await resolveNotionUserId(props.owner);
      if (notionUserId) {
        properties["Owner"] = { people: [{ id: notionUserId }] };
      }
    }

    const page = await client.pages.create({
      parent: { database_id: config.NOTION_PROJECTS_DATABASE_ID },
      properties,
    }) as any;

    return page.url ?? null;
  } catch (err) {
    logger.error({ err, name }, "Failed to create Notion project");
    return null;
  }
}

export async function getNotionTasksViaSearch(): Promise<NotionTask[]> {
  if (!config.NOTION_TASKS_DATABASE_ID) return [];

  const client = getClient();
  const now = new Date();

  try {
    const search = await client.search({
      filter: { property: "object", value: "page" },
      page_size: 100,
    });

    const dbPages = search.results.filter(
      (p: any) => p.parent?.database_id === config.NOTION_TASKS_DATABASE_ID && !p.archived,
    );

    return dbPages.map((page: any) => {
      const props = page.properties ?? {};
      const dueDate = extractDate(props, "Due date", "Due Date", "Due", "Deadline", "Date");
      return {
        id: page.id,
        title: extractTitle(props) || (props["Task name"]?.title?.[0]?.plain_text ?? "Untitled"),
        status: extractSelect(props, "Status", "State") || (props["Status"]?.status?.name ?? ""),
        priority: extractSelect(props, "Priority", "Priorita") || "",
        assignee: extractPerson(props, "Assignee", "Assign", "Person", "Owner"),
        dueDate,
        url: page.url ?? "",
        isOverdue: dueDate ? new Date(dueDate) < now : false,
      };
    });
  } catch (err) {
    logger.error({ err }, "Failed to fetch Notion tasks via search");
    return [];
  }
}

export async function updateNotionDashboardPage(metrics: Record<string, any>): Promise<void> {
  const client = getClient();

  // Search for existing dashboard page
  try {
    const search = await client.search({
      query: "COO Dashboard",
      filter: { property: "object", value: "page" },
    });

    let pageId: string | null = null;

    if (search.results.length) {
      pageId = search.results[0].id;
    }

    const content = `# COO Dashboard — ${new Date().toLocaleDateString("it-IT")}

## Metriche
- Task attivi: ${metrics.activeTasks ?? 0}
- Task completati oggi: ${metrics.completedToday ?? 0}
- Task overdue: ${metrics.overdue ?? 0}
- Team members: ${metrics.teamSize ?? 0}

## Team Workload
${metrics.workload?.map((w: any) => `- ${w.name}: ${w.score}`).join("\n") ?? "N/A"}

## Ultime decisioni
${metrics.recentDecisions ?? "Nessuna decisione recente."}

_Aggiornato automaticamente dal COO Assistant_`;

    if (pageId) {
      await client.pages.updateMarkdown({ page_id: pageId, markdown: content } as any).catch(() => {});
    }
  } catch (err) {
    logger.error({ err }, "Failed to update Notion dashboard");
  }
}

// --- Scheduled Job ---

export async function syncNotionData(): Promise<void> {
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

    await sendOwnerNotification(msg).catch((err) => logger.error({ err }, "Failed to send Notion overdue notification"));
  }

  logger.info(
    { tasks: data.tasks.length, projects: data.projects.length },
    "Notion sync complete",
  );
}
