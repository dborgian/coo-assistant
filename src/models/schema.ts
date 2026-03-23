import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const employees = sqliteTable("employees", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email"),
  telegramUserId: integer("telegram_user_id"),
  telegramUsername: text("telegram_username"),
  role: text("role"),
  department: text("department"),
  isActive: integer("is_active", { mode: "boolean" }).default(true),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

export const clients = sqliteTable("clients", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  company: text("company"),
  email: text("email"),
  telegramChatId: integer("telegram_chat_id"),
  notes: text("notes"),
  isActive: integer("is_active", { mode: "boolean" }).default(true),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

export const tasks = sqliteTable("tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").default("pending"), // pending, in_progress, done, cancelled
  priority: text("priority").default("medium"), // low, medium, high, urgent
  assignedTo: integer("assigned_to").references(() => employees.id),
  clientId: integer("client_id").references(() => clients.id),
  dueDate: text("due_date"), // ISO datetime string
  reminderAt: text("reminder_at"),
  reminderSent: integer("reminder_sent", { mode: "boolean" }).default(false),
  source: text("source"), // manual, kanbanchi, calendar
  externalId: text("external_id"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
});

export const messageLogs = sqliteTable("message_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  source: text("source").notNull(), // telegram, gmail, kanbanchi
  chatId: integer("chat_id"),
  chatTitle: text("chat_title"),
  senderName: text("sender_name"),
  senderId: integer("sender_id"),
  content: text("content").notNull(),
  urgency: text("urgency").default("normal"), // low, normal, high, critical
  needsReply: integer("needs_reply", { mode: "boolean" }).default(false),
  replied: integer("replied", { mode: "boolean" }).default(false),
  notifiedOwner: integer("notified_owner", { mode: "boolean" }).default(false),
  receivedAt: text("received_at").default(sql`(datetime('now'))`),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

export const dailyReports = sqliteTable("daily_reports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  reportDate: text("report_date").notNull(), // YYYY-MM-DD
  reportType: text("report_type").default("daily"), // daily, weekly, on_demand
  content: text("content").notNull(),
  sentVia: text("sent_via").default("telegram"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});
