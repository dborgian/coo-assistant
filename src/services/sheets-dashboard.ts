import { google } from "googleapis";
import type { Bot } from "grammy";
import { and, eq, inArray, sql, gte } from "drizzle-orm";
import { config } from "../config.js";
import { getGoogleAuth, isGoogleConfigured } from "../core/google-auth.js";
import { db } from "../models/database.js";
import { employees, employeeMetrics, tasks, messageLogs } from "../models/schema.js";
import { logger } from "../utils/logger.js";

const SHEET_TITLE = "COO Dashboard";

async function getOrCreateSheet(): Promise<string | null> {
  const auth = getGoogleAuth();
  if (!auth) return null;

  const sheets = google.sheets({ version: "v4", auth });
  const drive = google.drive({ version: "v3", auth });

  // Search for existing sheet
  try {
    const res = await drive.files.list({
      q: `name='${SHEET_TITLE}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
      fields: "files(id)",
    });

    if (res.data.files?.length) {
      return res.data.files[0].id!;
    }

    // Create new spreadsheet
    const newSheet = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title: SHEET_TITLE },
        sheets: [
          { properties: { title: "Weekly Metrics" } },
          { properties: { title: "Team Workload" } },
          { properties: { title: "Task Summary" } },
        ],
      },
    });

    const spreadsheetId = newSheet.data.spreadsheetId!;

    // Move to COO folder if configured
    if (config.COO_DRIVE_FOLDER_ID) {
      await drive.files.update({
        fileId: spreadsheetId,
        addParents: config.COO_DRIVE_FOLDER_ID,
        fields: "id,parents",
      });
    }

    logger.info({ spreadsheetId }, "Created COO Dashboard spreadsheet");
    return spreadsheetId;
  } catch (err) {
    logger.error({ err }, "Failed to get/create dashboard sheet");
    return null;
  }
}

export async function exportWeeklyMetrics(bot: Bot): Promise<void> {
  if (!isGoogleConfigured()) {
    logger.debug("Sheets export skipped — Google not configured");
    return;
  }

  const spreadsheetId = await getOrCreateSheet();
  if (!spreadsheetId) return;

  const auth = getGoogleAuth()!;
  const sheets = google.sheets({ version: "v4", auth });

  const now = new Date();
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);
  const today = now.toISOString().split("T")[0];

  try {
    // Gather metrics
    const [completedCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(and(eq(tasks.status, "done"), gte(tasks.updatedAt, weekAgo)));

    const [createdCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(gte(tasks.createdAt, weekAgo));

    const activeTasks = await db
      .select()
      .from(tasks)
      .where(inArray(tasks.status, ["pending", "in_progress"]));

    const overdue = activeTasks.filter(
      (t) => t.dueDate && new Date(t.dueDate) < now,
    );

    const [slackCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(messageLogs)
      .where(and(eq(messageLogs.source, "slack"), gte(messageLogs.receivedAt, weekAgo)));

    const [emailCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(messageLogs)
      .where(and(eq(messageLogs.source, "gmail"), gte(messageLogs.receivedAt, weekAgo)));

    // Write weekly metrics row
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "Weekly Metrics!A:H",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          today,
          Number(createdCount?.count ?? 0),
          Number(completedCount?.count ?? 0),
          activeTasks.length,
          overdue.length,
          Number(slackCount?.count ?? 0),
          Number(emailCount?.count ?? 0),
          `${activeTasks.length > 0 ? Math.round((Number(completedCount?.count ?? 0) / (Number(completedCount?.count ?? 0) + activeTasks.length)) * 100) : 0}%`,
        ]],
      },
    });

    // Write team workload
    const activeEmployees = await db
      .select()
      .from(employees)
      .where(eq(employees.isActive, true));

    const teamRows: any[][] = [];
    for (const emp of activeEmployees) {
      const [assigned] = await db
        .select({ count: sql<number>`count(*)` })
        .from(tasks)
        .where(
          and(eq(tasks.assignedTo, emp.id), inArray(tasks.status, ["pending", "in_progress"])),
        );

      const [overdueEmp] = await db
        .select({ count: sql<number>`count(*)` })
        .from(tasks)
        .where(
          and(eq(tasks.assignedTo, emp.id), inArray(tasks.status, ["pending", "in_progress"]), sql`${tasks.dueDate} < NOW()`),
        );

      teamRows.push([
        today,
        emp.name,
        emp.role ?? "",
        Number(assigned?.count ?? 0),
        Number(overdueEmp?.count ?? 0),
      ]);
    }

    if (teamRows.length) {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: "Team Workload!A:E",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: teamRows },
      });
    }

    // Write task summary
    const taskRows = activeTasks.slice(0, 50).map((t) => [
      today,
      t.title,
      t.status,
      t.priority,
      t.dueDate ? new Date(t.dueDate).toISOString().split("T")[0] : "",
      t.dueDate && new Date(t.dueDate) < now ? "OVERDUE" : "",
    ]);

    if (taskRows.length) {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: "Task Summary!A:F",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: taskRows },
      });
    }

    // Get sheet URL
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;

    await bot.api.sendMessage(
      config.TELEGRAM_OWNER_CHAT_ID,
      `\uD83D\uDCCA Dashboard aggiornata su Google Sheets:\n${sheetUrl}`,
    );

    logger.info("Weekly metrics exported to Google Sheets");
  } catch (err) {
    logger.error({ err }, "Failed to export metrics to Sheets");
  }
}
