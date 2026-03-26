import { pgTable, text, boolean, uuid, timestamp, date, bigint, integer, real, index } from "drizzle-orm/pg-core";

export const employees = pgTable("employees", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email"),
  role: text("role"),
  department: text("department"),
  isActive: boolean("is_active").default(true),
  // Google
  googleEmail: text("google_email"),
  googleUserId: text("google_user_id"),
  // Notion
  notionUserId: text("notion_user_id"),
  notionUserName: text("notion_user_name"),
  // Slack
  slackMemberId: text("slack_member_id").unique(),
  slackUsername: text("slack_username"),
  // Telegram
  telegramUserId: bigint("telegram_user_id", { mode: "number" }).unique(),
  telegramUsername: text("telegram_username"),
  // Timestamps
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_employees_active").on(t.isActive),
]);

export const clients = pgTable("clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  company: text("company"),
  email: text("email"),
  telegramChatId: bigint("telegram_chat_id", { mode: "number" }),
  notes: text("notes"),
  isActive: boolean("is_active").default(true),
  // External refs
  notionPageId: text("notion_page_id"),
  slackChannelId: text("slack_channel_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").default("pending"), // pending, in_progress, done, cancelled
  priority: text("priority").default("medium"), // low, medium, high, urgent
  assignedTo: uuid("assigned_to").references(() => employees.id),
  clientId: uuid("client_id").references(() => clients.id),
  dueDate: timestamp("due_date", { withTimezone: true }),
  reminderAt: timestamp("reminder_at", { withTimezone: true }),
  reminderSent: boolean("reminder_sent").default(false),
  source: text("source"), // manual, notion, calendar
  externalId: text("external_id"),
  // Scheduling
  estimatedMinutes: integer("estimated_minutes"),
  scheduledStart: timestamp("scheduled_start", { withTimezone: true }),
  scheduledEnd: timestamp("scheduled_end", { withTimezone: true }),
  autoScheduled: boolean("auto_scheduled").default(false),
  calendarEventId: text("calendar_event_id"), // Google Calendar event ID
  // Dependencies
  blockedBy: text("blocked_by"), // JSON array of task IDs
  // Escalation tracking
  escalationLevel: integer("escalation_level").default(0), // 0-4
  lastEscalatedAt: timestamp("last_escalated_at", { withTimezone: true }),
  escalationPausedUntil: timestamp("escalation_paused_until", { withTimezone: true }),
  // Recurrence
  isRecurring: boolean("is_recurring").default(false),
  recurrencePattern: text("recurrence_pattern"), // daily, weekly, monthly
  recurrenceDays: text("recurrence_days"), // JSON array e.g. [1,3,5] for mon/wed/fri
  recurrenceEndDate: timestamp("recurrence_end_date", { withTimezone: true }),
  recurrenceParentId: uuid("recurrence_parent_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_tasks_status").on(t.status),
  index("idx_tasks_assigned").on(t.assignedTo),
  index("idx_tasks_due").on(t.dueDate),
  index("idx_tasks_external").on(t.source, t.externalId),
]);

export const messageLogs = pgTable("message_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  source: text("source").notNull(), // telegram, slack, gmail
  employeeId: uuid("employee_id").references(() => employees.id),
  chatId: bigint("chat_id", { mode: "number" }),
  chatTitle: text("chat_title"),
  senderName: text("sender_name"),
  senderId: text("sender_id"),
  content: text("content").notNull(),
  urgency: text("urgency").default("normal"), // low, normal, high, critical
  needsReply: boolean("needs_reply").default(false),
  replied: boolean("replied").default(false),
  notifiedOwner: boolean("notified_owner").default(false),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_msglogs_source_received").on(t.source, t.receivedAt),
  index("idx_msglogs_pending").on(t.needsReply, t.replied),
  index("idx_msglogs_employee").on(t.employeeId, t.receivedAt),
]);

export const employeeMetrics = pgTable("employee_metrics", {
  id: uuid("id").primaryKey().defaultRandom(),
  employeeId: uuid("employee_id").references(() => employees.id).notNull(),
  date: date("date").notNull(),
  tasksAssigned: integer("tasks_assigned").default(0),
  tasksCompleted: integer("tasks_completed").default(0),
  tasksOverdue: integer("tasks_overdue").default(0),
  avgCompletionDays: real("avg_completion_days"),
  slackMessages: integer("slack_messages").default(0),
  emailsSent: integer("emails_sent").default(0),
  workloadScore: real("workload_score"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_emp_metrics_date").on(t.employeeId, t.date),
]);

export const dailyReports = pgTable("daily_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  reportDate: date("report_date").notNull(),
  reportType: text("report_type").default("daily"), // daily, weekly, on_demand
  content: text("content").notNull(),
  sentVia: text("sent_via").default("telegram"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_reports_date").on(t.reportDate),
]);
