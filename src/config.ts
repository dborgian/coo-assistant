import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ override: true });

const envSchema = z.object({
  // Telegram Bot
  TELEGRAM_BOT_TOKEN: z.string(),
  TELEGRAM_OWNER_CHAT_ID: z.coerce.number(),

  // GramJS (userbot for monitoring)
  TELEGRAM_API_ID: z.coerce.number().default(0),
  TELEGRAM_API_HASH: z.string().default(""),
  TELEGRAM_SESSION_STRING: z.string().default(""),
  MONITORED_CHAT_IDS: z
    .string()
    .default("[]")
    .transform((v) => JSON.parse(v) as number[]),

  // Anthropic
  ANTHROPIC_API_KEY: z.string(),
  AGENT_MODEL: z.string().default("claude-sonnet-4-20250514"),

  // Google OAuth2
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  GOOGLE_REDIRECT_URI: z
    .string()
    .default("http://localhost:8080/oauth/callback"),
  GOOGLE_REFRESH_TOKEN: z.string().default(""),

  // Gmail
  EMAIL_CHECK_INTERVAL_MINUTES: z.coerce.number().default(10),

  // Slack (Socket Mode for real-time monitoring)
  SLACK_BOT_TOKEN: z.string().default(""),
  SLACK_APP_TOKEN: z.string().default(""),
  SLACK_SIGNING_SECRET: z.string().default(""),
  MONITORED_SLACK_CHANNELS: z
    .string()
    .default("[]")
    .transform((v) => JSON.parse(v) as string[]),

  // Kanbanchi (via Google Drive backup)
  KANBANCHI_FOLDER_ID: z.string().default(""),
  KANBANCHI_BOARD_NAME: z.string().default(""),
  KANBANCHI_SYNC_INTERVAL_MINUTES: z.coerce.number().default(30),

  // Database
  DATABASE_PATH: z.string().default("./data/coo.db"),

  // Scheduling
  DAILY_REPORT_HOUR: z.coerce.number().default(8),
  DAILY_REPORT_MINUTE: z.coerce.number().default(0),
  TIMEZONE: z.string().default("America/New_York"),
  CHAT_CHECK_INTERVAL_MINUTES: z.coerce.number().default(5),
  CALENDAR_CHECK_INTERVAL_MINUTES: z.coerce.number().default(15),
});

export const config = envSchema.parse(process.env);
export type Config = z.infer<typeof envSchema>;
