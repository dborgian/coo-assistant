import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { config } from "../config.js";
import * as schema from "./schema.js";

// Ensure data directory exists
mkdirSync(dirname(config.DATABASE_PATH), { recursive: true });

const sqlite = new Database(config.DATABASE_PATH);
sqlite.pragma("journal_mode = WAL");

export const db = drizzle(sqlite, { schema });

export function initDb(): void {
  // Create tables if they don't exist
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT,
      telegram_user_id INTEGER,
      telegram_username TEXT,
      role TEXT,
      department TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      company TEXT,
      email TEXT,
      telegram_chat_id INTEGER,
      notes TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'pending',
      priority TEXT DEFAULT 'medium',
      assigned_to INTEGER REFERENCES employees(id),
      client_id INTEGER REFERENCES clients(id),
      due_date TEXT,
      reminder_at TEXT,
      reminder_sent INTEGER DEFAULT 0,
      source TEXT,
      external_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS message_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      chat_id INTEGER,
      chat_title TEXT,
      sender_name TEXT,
      sender_id INTEGER,
      content TEXT NOT NULL,
      urgency TEXT DEFAULT 'normal',
      needs_reply INTEGER DEFAULT 0,
      replied INTEGER DEFAULT 0,
      notified_owner INTEGER DEFAULT 0,
      received_at TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS daily_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_date TEXT NOT NULL,
      report_type TEXT DEFAULT 'daily',
      content TEXT NOT NULL,
      sent_via TEXT DEFAULT 'telegram',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}
