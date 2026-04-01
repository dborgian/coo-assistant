import PDFDocument from "pdfkit";
import { and, eq, gte, lte, sql, desc } from "drizzle-orm";
import { db } from "../models/database.js";
import { employees, tasks, messageLogs } from "../models/schema.js";
import { agent } from "../core/agent.js";
import { getNotionWorkspaceSummary, isNotionConfigured } from "./notion-sync.js";
import { logger } from "../utils/logger.js";

const C = {
  primary: "#1a1a2e", accent: "#16213e", green: "#0f9b58", yellow: "#f4b400",
  red: "#db4437", blue: "#4285f4", purple: "#7b1fa2", muted: "#888888",
  light: "#f0f0f0", border: "#cccccc", white: "#ffffff", black: "#333333",
};

const PAGE_W = 595.28; // A4
const MARGIN = 50;
const CONTENT_W = PAGE_W - MARGIN * 2;

function stripEmoji(text: string): string {
  return text.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, "").replace(/\s{2,}/g, " ");
}

function fmtDate(d: Date | string | null): string {
  if (!d) return "-";
  return new Date(d).toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function ensureSpace(doc: PDFKit.PDFDocument, needed = 80): void {
  if (doc.y > doc.page.height - needed) doc.addPage();
}

// ─── Layout Blocks ─────────────────────────────────────────

function drawHeader(doc: PDFKit.PDFDocument, title: string, subtitle: string, period: string): void {
  doc.save();
  doc.rect(0, 0, PAGE_W, 80).fill(C.primary);
  doc.font("Helvetica-Bold").fontSize(18).fillColor(C.white).text(title, MARGIN, 16, { width: CONTENT_W });
  doc.font("Helvetica").fontSize(10).fillColor("#bbbbbb").text(subtitle, MARGIN, 40, { width: CONTENT_W });
  doc.fontSize(9).text(period, MARGIN, 56, { width: CONTENT_W });
  doc.restore();
  doc.fillColor(C.black).font("Helvetica");
  doc.x = MARGIN;
  doc.y = 95;
}

function drawKpiBoxes(doc: PDFKit.PDFDocument, kpis: { label: string; value: number | string; color: string }[]): void {
  const gap = 8;
  const boxW = (CONTENT_W - (kpis.length - 1) * gap) / kpis.length;
  const boxH = 44;
  const startY = doc.y;

  doc.save();
  for (let i = 0; i < kpis.length; i++) {
    const x = MARGIN + i * (boxW + gap);
    doc.roundedRect(x, startY, boxW, boxH, 4).fill(kpis[i].color);
    doc.font("Helvetica-Bold").fontSize(15).fillColor(C.white)
      .text(String(kpis[i].value), x + 4, startY + 6, { width: boxW - 8, align: "center" });
    doc.font("Helvetica").fontSize(7).fillColor("#dddddd")
      .text(kpis[i].label, x + 4, startY + 26, { width: boxW - 8, align: "center" });
  }
  doc.restore();
  doc.fillColor(C.black).font("Helvetica");
  doc.x = MARGIN;
  doc.y = startY + boxH + 12;
}

function drawSection(doc: PDFKit.PDFDocument, title: string): void {
  ensureSpace(doc, 60);
  doc.moveDown(0.5);
  doc.font("Helvetica-Bold").fontSize(11).fillColor(C.accent).text(title.toUpperCase(), MARGIN, doc.y, { width: CONTENT_W });
  const lineY = doc.y + 2;
  doc.save().moveTo(MARGIN, lineY).lineTo(MARGIN + CONTENT_W, lineY).lineWidth(0.5).stroke(C.border).restore();
  doc.moveDown(0.4);
  doc.font("Helvetica").fontSize(9).fillColor(C.black);
}

function drawBarChart(doc: PDFKit.PDFDocument, title: string, items: { label: string; value: number; color: string }[]): void {
  if (!items.length) return;
  ensureSpace(doc, 30 + items.length * 22);

  doc.font("Helvetica-Bold").fontSize(9).fillColor(C.accent).text(title, MARGIN, doc.y, { width: CONTENT_W });
  doc.moveDown(0.3);

  const maxVal = Math.max(...items.map((i) => i.value), 1);
  const labelW = 90;
  const barX = MARGIN + labelW + 8;
  const barMaxW = CONTENT_W - labelW - 50;

  for (const item of items) {
    ensureSpace(doc, 22);
    const y = doc.y;
    const barW = Math.max((item.value / maxVal) * barMaxW, 3);

    doc.save();
    doc.font("Helvetica").fontSize(8).fillColor(C.muted)
      .text(item.label, MARGIN, y + 2, { width: labelW, align: "right" });
    doc.roundedRect(barX, y, barW, 14, 2).fill(item.color);
    doc.font("Helvetica-Bold").fontSize(8).fillColor(C.black)
      .text(String(item.value), barX + barW + 4, y + 2);
    doc.restore();

    doc.x = MARGIN;
    doc.y = y + 20;
  }
  doc.moveDown(0.3);
  doc.fillColor(C.black).font("Helvetica");
}

function drawPieChart(doc: PDFKit.PDFDocument, title: string, items: { label: string; value: number; color: string }[]): void {
  if (!items.length) return;
  const total = items.reduce((s, i) => s + i.value, 0);
  if (!total) return;
  ensureSpace(doc, 120);

  doc.font("Helvetica-Bold").fontSize(9).fillColor(C.accent).text(title, MARGIN, doc.y, { width: CONTENT_W });
  doc.moveDown(0.3);

  const cx = MARGIN + 55;
  const cy = doc.y + 45;
  const r = 40;
  let startAngle = -Math.PI / 2;

  doc.save();
  for (const item of items) {
    const sliceAngle = (item.value / total) * 2 * Math.PI;
    const endAngle = startAngle + sliceAngle;

    // Draw arc segment
    doc.path(`M ${cx} ${cy} L ${cx + r * Math.cos(startAngle)} ${cy + r * Math.sin(startAngle)} A ${r} ${r} 0 ${sliceAngle > Math.PI ? 1 : 0} 1 ${cx + r * Math.cos(endAngle)} ${cy + r * Math.sin(endAngle)} Z`).fill(item.color);

    startAngle = endAngle;
  }
  // White center for donut effect
  doc.circle(cx, cy, r * 0.55).fill(C.white);
  // Total in center
  doc.font("Helvetica-Bold").fontSize(12).fillColor(C.black)
    .text(String(total), cx - 15, cy - 7, { width: 30, align: "center" });
  doc.restore();

  // Legend on the right
  let ly = cy - (items.length * 14) / 2;
  const lx = cx + r + 25;
  for (const item of items) {
    doc.save();
    doc.rect(lx, ly, 10, 10).fill(item.color);
    doc.restore();
    const pct = Math.round((item.value / total) * 100);
    doc.font("Helvetica").fontSize(8).fillColor(C.black)
      .text(`${item.label}: ${item.value} (${pct}%)`, lx + 14, ly + 1);
    ly += 14;
  }

  doc.x = MARGIN;
  doc.y = cy + r + 15;
  doc.fillColor(C.black).font("Helvetica");
}

function drawNarrative(doc: PDFKit.PDFDocument, text: string): void {
  const clean = stripEmoji(text);
  for (const rawLine of clean.split("\n")) {
    ensureSpace(doc, 16);
    const line = rawLine.trim();
    if (!line) { doc.moveDown(0.15); continue; }

    // ALL-CAPS section header
    if (/^[A-Z][A-Z\s\/]{4,}$/.test(line)) { drawSection(doc, line); continue; }
    // Markdown header
    if (/^#{1,3}\s/.test(line)) { drawSection(doc, line.replace(/^#+\s*/, "")); continue; }
    // Bold line
    if (line.startsWith("**") && line.endsWith("**")) {
      doc.font("Helvetica-Bold").fontSize(9).text(line.replace(/\*\*/g, ""), MARGIN, doc.y, { width: CONTENT_W, lineGap: 1.5 });
      doc.font("Helvetica");
      continue;
    }
    // Bullet
    if (line.startsWith("- ") || line.startsWith("* ")) {
      doc.fontSize(9).text(`  \u2022  ${stripEmoji(line.slice(2))}`, MARGIN + 8, doc.y, { width: CONTENT_W - 16, lineGap: 1.5 });
      continue;
    }
    // Regular text
    doc.fontSize(9).text(stripEmoji(line), MARGIN, doc.y, { width: CONTENT_W, lineGap: 1.5 });
  }
}

function drawTaskTable(doc: PDFKit.PDFDocument, taskList: any[]): void {
  if (!taskList.length) { doc.fontSize(9).text("  Nessun task.", MARGIN); return; }

  ensureSpace(doc, 40);
  const cols = [60, 50, CONTENT_W - 60 - 50 - 80, 80];
  const headers = ["Status", "Priority", "Title", "Due Date"];

  // Header row
  doc.save();
  doc.rect(MARGIN, doc.y, CONTENT_W, 16).fill(C.light);
  doc.restore();
  const hy = doc.y + 3;
  doc.font("Helvetica-Bold").fontSize(7.5).fillColor(C.muted);
  let hx = MARGIN + 4;
  for (let i = 0; i < headers.length; i++) {
    doc.text(headers[i], hx, hy, { width: cols[i], continued: false });
    hx += cols[i];
  }
  doc.y = hy + 15;

  // Rows
  doc.font("Helvetica").fontSize(8).fillColor(C.black);
  for (const t of taskList.slice(0, 25)) {
    ensureSpace(doc, 16);
    const ry = doc.y;
    let rx = MARGIN + 4;

    doc.text(t.status ?? "?", rx, ry, { width: cols[0] }); rx += cols[0];
    const pColor = (t.priority === "urgent" || t.priority === "high") ? C.red : C.muted;
    doc.fillColor(pColor).text(t.priority ?? "-", rx, ry, { width: cols[1] }); rx += cols[1];
    doc.fillColor(C.black).text((t.title ?? "").slice(0, 55), rx, ry, { width: cols[2] }); rx += cols[2];
    doc.fillColor(C.muted).text(t.due ? fmtDate(t.due) : "-", rx, ry, { width: cols[3] });
    doc.fillColor(C.black);
    doc.y = ry + 14;
  }
  if (taskList.length > 25) {
    doc.fontSize(7).fillColor(C.muted).text(`  ... +${taskList.length - 25} altri task`, MARGIN);
    doc.fillColor(C.black);
  }
  doc.moveDown(0.3);
}

function drawFooter(doc: PDFKit.PDFDocument): void {
  doc.moveDown(1.5);
  doc.fontSize(7).fillColor(C.muted).text(
    `Generated by COO Assistant | ${new Date().toLocaleString("it-IT")}`,
    MARGIN, doc.y, { width: CONTENT_W, align: "center" },
  );
}

// ─── Public Generators ─────────────────────────────────────

export interface DailyReportData {
  narrative: string;
  date: string;
  taskCount: number;
  overdueCount: number;
  doneCount: number;
  slackMsgCount: number;
  emailCount: number;
  calendarCount: number;
  notionTaskCount: number;
  taskList: { title: string; status: string | null; priority: string | null; due: Date | null }[];
  msgBySource: { label: string; value: number; color: string }[];
}

export async function generateDailyReportPdf(data: DailyReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: MARGIN, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    drawHeader(doc, "Daily Operations Report", "COO Assistant", fmtDate(data.date));

    // KPI boxes
    drawKpiBoxes(doc, [
      { label: "TASK ATTIVI", value: data.taskCount, color: C.blue },
      { label: "COMPLETATI", value: data.doneCount, color: C.green },
      { label: "OVERDUE", value: data.overdueCount, color: data.overdueCount ? C.red : C.green },
      { label: "MESSAGGI", value: data.slackMsgCount, color: C.purple },
    ]);

    // Pie chart: task distribution
    const taskPie: { label: string; value: number; color: string }[] = [];
    if (data.taskCount) taskPie.push({ label: "Attivi", value: data.taskCount, color: C.blue });
    if (data.doneCount) taskPie.push({ label: "Completati", value: data.doneCount, color: C.green });
    if (data.overdueCount) taskPie.push({ label: "Overdue", value: data.overdueCount, color: C.red });
    if (taskPie.length) drawPieChart(doc, "Distribuzione Task", taskPie);

    // Bar chart: messages by source
    if (data.msgBySource.length) drawBarChart(doc, "Comunicazione per Canale", data.msgBySource);

    // Overview bar: calendar, email, notion, slack
    const overviewChart = [
      { label: "Calendar", value: data.calendarCount, color: "#039be5" },
      { label: "Email", value: data.emailCount, color: "#ea4335" },
      { label: "Slack", value: data.slackMsgCount, color: "#611f69" },
      { label: "Notion", value: data.notionTaskCount, color: C.black },
    ].filter((i) => i.value > 0);
    if (overviewChart.length) drawBarChart(doc, "Panoramica Integrazioni", overviewChart);

    // AI narrative
    drawSection(doc, "Report Operativo");
    drawNarrative(doc, data.narrative);

    // Task table
    if (data.taskList.length) {
      drawSection(doc, "Dettaglio Task");
      drawTaskTable(doc, data.taskList);
    }

    drawFooter(doc);
    doc.end();
  });
}

export async function generateEmployeeReportPdf(name: string, startDate: Date, endDate: Date): Promise<Buffer> {
  const [emp] = await db.select({ id: employees.id, name: employees.name, role: employees.role, email: employees.email }).from(employees)
    .where(sql`${employees.name} ILIKE ${"%" + name + "%"}`).limit(1);
  if (!emp) return errPdf(`Employee "${name}" not found.`);

  const [empTasks, empMsgs, notionData] = await Promise.all([
    db.select().from(tasks).where(eq(tasks.assignedTo, emp.id)),
    db.select().from(messageLogs).where(and(
      sql`(${messageLogs.employeeId} = ${emp.id} OR ${messageLogs.senderName} ILIKE ${"%" + emp.name + "%"})`,
      gte(messageLogs.receivedAt, startDate), lte(messageLogs.receivedAt, endDate),
    )).orderBy(desc(messageLogs.receivedAt)),
    isNotionConfigured() ? getNotionWorkspaceSummary().catch(() => null) : Promise.resolve(null),
  ]);

  const notionTasks = notionData?.tasks.filter((t) => t.assignee?.toLowerCase().includes(emp.name.toLowerCase())) ?? [];
  const active = empTasks.filter((t) => t.status === "pending" || t.status === "in_progress");
  const done = empTasks.filter((t) => t.status === "done");
  const overdue = active.filter((t) => t.dueDate && new Date(t.dueDate) < new Date());
  const slack = empMsgs.filter((m) => m.source === "slack");
  const telegram = empMsgs.filter((m) => m.source === "telegram");
  const gmail = empMsgs.filter((m) => m.source === "gmail");

  // AI narrative
  let narrative = "";
  try {
    narrative = await agent.generateEmployeeNarrative(emp.name, {
      employee: { name: emp.name, role: emp.role, email: emp.email },
      period: `${fmtDate(startDate)} - ${fmtDate(endDate)}`,
      stats: { total_tasks: empTasks.length, active: active.length, completed: done.length, overdue: overdue.length, messages: empMsgs.length, slack: slack.length, telegram: telegram.length },
      tasks: empTasks.map((t) => ({ title: t.title, status: t.status, priority: t.priority, due: t.dueDate })),
      notion_tasks: notionTasks.map((t) => ({ title: t.title, status: t.status, priority: t.priority, due: t.dueDate })),
      recent_messages: empMsgs.slice(0, 30).map((m) => ({ source: m.source, channel: m.chatTitle, content: m.content.slice(0, 200), time: m.receivedAt })),
    });
  } catch (err) {
    logger.error({ err }, "AI narrative failed");
    narrative = "Generazione report AI non disponibile.";
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: MARGIN, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    drawHeader(doc, `Report: ${emp.name}`, emp.role ?? "Team Member", `${fmtDate(startDate)} - ${fmtDate(endDate)}`);

    drawKpiBoxes(doc, [
      { label: "TASK ATTIVI", value: active.length, color: C.blue },
      { label: "COMPLETATI", value: done.length, color: C.green },
      { label: "OVERDUE", value: overdue.length, color: overdue.length ? C.red : C.green },
      { label: "MESSAGGI", value: empMsgs.length, color: C.purple },
    ]);

    // Charts — pie for tasks, bar for messages
    const taskChart: { label: string; value: number; color: string }[] = [];
    if (active.length) taskChart.push({ label: "Attivi", value: active.length, color: C.blue });
    if (done.length) taskChart.push({ label: "Completati", value: done.length, color: C.green });
    if (overdue.length) taskChart.push({ label: "Overdue", value: overdue.length, color: C.red });
    if (taskChart.length) drawPieChart(doc, "Distribuzione Task", taskChart);

    const msgChart: { label: string; value: number; color: string }[] = [];
    if (slack.length) msgChart.push({ label: "Slack", value: slack.length, color: "#611f69" });
    if (telegram.length) msgChart.push({ label: "Telegram", value: telegram.length, color: "#0088cc" });
    if (gmail.length) msgChart.push({ label: "Gmail", value: gmail.length, color: "#ea4335" });
    if (msgChart.length) drawBarChart(doc, "Messaggi per Canale", msgChart);

    // AI narrative
    drawSection(doc, "Analisi Operativa");
    drawNarrative(doc, narrative);

    // Task table
    drawSection(doc, "Dettaglio Task");
    drawTaskTable(doc, empTasks.map((t) => ({ title: t.title, status: t.status, priority: t.priority, due: t.dueDate })));

    if (notionTasks.length) {
      drawSection(doc, "Notion Tasks");
      drawTaskTable(doc, notionTasks.map((t) => ({ title: t.title, status: t.status, priority: t.priority, due: t.dueDate })));
    }

    drawFooter(doc);
    doc.end();
  });
}

export async function generateWeeklyReportPdf(startDate: Date, endDate: Date): Promise<Buffer> {
  const [allTasks, allMsgs, allEmps, notionData] = await Promise.all([
    db.select().from(tasks),
    db.select().from(messageLogs).where(and(gte(messageLogs.receivedAt, startDate), lte(messageLogs.receivedAt, endDate))),
    db.select({ id: employees.id, name: employees.name, role: employees.role, email: employees.email }).from(employees).where(eq(employees.isActive, true)),
    isNotionConfigured() ? getNotionWorkspaceSummary().catch(() => null) : Promise.resolve(null),
  ]);

  const active = allTasks.filter((t) => t.status === "pending" || t.status === "in_progress");
  const done = allTasks.filter((t) => t.status === "done");
  const overdue = active.filter((t) => t.dueDate && new Date(t.dueDate) < new Date());

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: MARGIN, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    drawHeader(doc, "Weekly Operations Report", "COO Assistant", `${fmtDate(startDate)} - ${fmtDate(endDate)}`);

    drawKpiBoxes(doc, [
      { label: "MESSAGGI", value: allMsgs.length, color: C.blue },
      { label: "TASK ATTIVI", value: active.length, color: C.yellow },
      { label: "COMPLETATI", value: done.length, color: C.green },
      { label: "OVERDUE", value: overdue.length, color: overdue.length ? C.red : C.green },
    ]);

    // Source chart
    const bySource = new Map<string, number>();
    for (const m of allMsgs) bySource.set(m.source, (bySource.get(m.source) ?? 0) + 1);
    const srcCol: Record<string, string> = { slack: "#611f69", telegram: "#0088cc", gmail: "#ea4335" };
    const srcItems = Array.from(bySource, ([s, v]) => ({ label: s, value: v, color: srcCol[s] ?? C.muted }));
    if (srcItems.length) drawBarChart(doc, "Comunicazione per Canale", srcItems);

    // Employee chart
    const empChart = allEmps.map((e) => {
      const n = allMsgs.filter((m) => m.employeeId === e.id || m.senderName?.toLowerCase().includes(e.name.toLowerCase())).length;
      return { label: e.name, value: n, color: C.blue };
    }).filter((e) => e.value > 0);
    if (empChart.length) drawBarChart(doc, "Messaggi per Employee", empChart);

    // Per-employee detail
    drawSection(doc, "Attivita per Employee");
    for (const e of allEmps) {
      ensureSpace(doc, 30);
      const eMsgs = allMsgs.filter((m) => m.employeeId === e.id || m.senderName?.toLowerCase().includes(e.name.toLowerCase())).length;
      const eTasks = allTasks.filter((t) => t.assignedTo === e.id);
      const eDone = eTasks.filter((t) => t.status === "done").length;
      doc.font("Helvetica-Bold").fontSize(9).text(`${e.name} (${e.role ?? "N/A"})`, MARGIN, doc.y, { width: CONTENT_W });
      doc.font("Helvetica").fontSize(8).fillColor(C.muted)
        .text(`Messaggi: ${eMsgs}  |  Task: ${eTasks.length}  |  Completati: ${eDone}`, MARGIN + 10, doc.y, { width: CONTENT_W - 10 });
      doc.fillColor(C.black);
      doc.moveDown(0.3);
    }

    if (notionData?.tasks.length) {
      drawSection(doc, "Notion Workspace");
      doc.fontSize(9).text(`Task totali: ${notionData.tasks.length}  |  Overdue: ${notionData.tasks.filter((t) => t.isOverdue).length}`, MARGIN, doc.y, { width: CONTENT_W });
    }

    drawFooter(doc);
    doc.end();
  });
}

function errPdf(msg: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: MARGIN, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.fontSize(14).font("Helvetica-Bold").text("Error", { align: "center" });
    doc.moveDown().fontSize(11).font("Helvetica").text(msg);
    doc.end();
  });
}
