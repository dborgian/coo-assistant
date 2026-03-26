/**
 * Database Migration Script
 *
 * Creates all tables and columns needed by the COO Assistant.
 * Idempotent — safe to run multiple times (uses IF NOT EXISTS).
 *
 * Usage: npx tsx scripts/db-migrate.ts
 */

import dotenv from "dotenv";
dotenv.config({ override: true });

import postgres from "postgres";

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("Error: SUPABASE_DB_URL not set in .env");
  process.exit(1);
}

const client = postgres(dbUrl);

async function migrate() {
  console.log("Running database migrations...\n");

  // ── Table: employees ──
  await client`
    CREATE TABLE IF NOT EXISTS employees (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      email TEXT,
      role TEXT,
      department TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      google_email TEXT,
      google_user_id TEXT,
      notion_user_id TEXT,
      notion_user_name TEXT,
      slack_member_id TEXT UNIQUE,
      slack_username TEXT,
      telegram_user_id BIGINT UNIQUE,
      telegram_username TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`;
  await client`CREATE INDEX IF NOT EXISTS idx_employees_active ON employees(is_active)`;
  console.log("✓ employees");

  // ── Table: clients ──
  await client`
    CREATE TABLE IF NOT EXISTS clients (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      company TEXT,
      email TEXT,
      telegram_chat_id BIGINT,
      notes TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      notion_page_id TEXT,
      slack_channel_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`;
  console.log("✓ clients");

  // ── Table: tasks ──
  await client`
    CREATE TABLE IF NOT EXISTS tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'pending',
      priority TEXT DEFAULT 'medium',
      assigned_to UUID REFERENCES employees(id),
      client_id UUID REFERENCES clients(id),
      due_date TIMESTAMPTZ,
      reminder_at TIMESTAMPTZ,
      reminder_sent BOOLEAN DEFAULT FALSE,
      source TEXT,
      external_id TEXT,
      estimated_minutes INTEGER,
      scheduled_start TIMESTAMPTZ,
      scheduled_end TIMESTAMPTZ,
      auto_scheduled BOOLEAN DEFAULT FALSE,
      calendar_event_id TEXT,
      blocked_by TEXT,
      escalation_level INTEGER DEFAULT 0,
      last_escalated_at TIMESTAMPTZ,
      escalation_paused_until TIMESTAMPTZ,
      is_recurring BOOLEAN DEFAULT FALSE,
      recurrence_pattern TEXT,
      recurrence_days TEXT,
      recurrence_end_date TIMESTAMPTZ,
      recurrence_parent_id UUID,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`;
  await client`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`;
  await client`CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to)`;
  await client`CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date)`;
  await client`CREATE INDEX IF NOT EXISTS idx_tasks_external ON tasks(source, external_id)`;
  console.log("✓ tasks");

  // ── Table: message_logs ──
  await client`
    CREATE TABLE IF NOT EXISTS message_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      source TEXT NOT NULL,
      employee_id UUID REFERENCES employees(id),
      chat_id BIGINT,
      chat_title TEXT,
      sender_name TEXT,
      sender_id TEXT,
      content TEXT NOT NULL,
      urgency TEXT DEFAULT 'normal',
      needs_reply BOOLEAN DEFAULT FALSE,
      replied BOOLEAN DEFAULT FALSE,
      notified_owner BOOLEAN DEFAULT FALSE,
      received_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`;
  await client`CREATE INDEX IF NOT EXISTS idx_msglogs_source_received ON message_logs(source, received_at)`;
  await client`CREATE INDEX IF NOT EXISTS idx_msglogs_pending ON message_logs(needs_reply, replied)`;
  await client`CREATE INDEX IF NOT EXISTS idx_msglogs_employee ON message_logs(employee_id, received_at)`;
  console.log("✓ message_logs");

  // ── Table: employee_metrics ──
  await client`
    CREATE TABLE IF NOT EXISTS employee_metrics (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      employee_id UUID NOT NULL REFERENCES employees(id),
      date DATE NOT NULL,
      tasks_assigned INTEGER DEFAULT 0,
      tasks_completed INTEGER DEFAULT 0,
      tasks_overdue INTEGER DEFAULT 0,
      avg_completion_days REAL,
      slack_messages INTEGER DEFAULT 0,
      emails_sent INTEGER DEFAULT 0,
      workload_score REAL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`;
  await client`CREATE INDEX IF NOT EXISTS idx_emp_metrics_date ON employee_metrics(employee_id, date)`;
  console.log("✓ employee_metrics");

  // ── Table: daily_reports ──
  await client`
    CREATE TABLE IF NOT EXISTS daily_reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      report_date DATE NOT NULL,
      report_type TEXT DEFAULT 'daily',
      content TEXT NOT NULL,
      sent_via TEXT DEFAULT 'telegram',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`;
  await client`CREATE INDEX IF NOT EXISTS idx_reports_date ON daily_reports(report_date)`;
  console.log("✓ daily_reports");

  // ── Add columns that may be missing (for upgrades) ──
  const addColumns = [
    "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS estimated_minutes INTEGER",
    "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS scheduled_start TIMESTAMPTZ",
    "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS scheduled_end TIMESTAMPTZ",
    "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS auto_scheduled BOOLEAN DEFAULT FALSE",
    "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS calendar_event_id TEXT",
    "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS blocked_by TEXT",
    "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS escalation_level INTEGER DEFAULT 0",
    "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS last_escalated_at TIMESTAMPTZ",
    "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS escalation_paused_until TIMESTAMPTZ",
    "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_recurring BOOLEAN DEFAULT FALSE",
    "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurrence_pattern TEXT",
    "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurrence_days TEXT",
    "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurrence_end_date TIMESTAMPTZ",
    "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurrence_parent_id UUID",
  ];

  for (const sql of addColumns) {
    await client.unsafe(sql);
  }
  console.log("✓ column upgrades applied");

  console.log("\n✅ All migrations completed successfully!");
  console.log(`   Database: ${dbUrl.replace(/:[^:@]+@/, ':***@')}`);
}

migrate()
  .catch((err) => {
    console.error("\n❌ Migration failed:", err.message);
    process.exit(1);
  })
  .finally(() => client.end());
