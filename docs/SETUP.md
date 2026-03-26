# COO Assistant — Detailed Setup Guide

## Prerequisites

- **Node.js 20+** — [Download](https://nodejs.org)
- **Telegram account**
- **Supabase account** (free tier works) — [Sign up](https://supabase.com)
- **Anthropic API key** — [Console](https://console.anthropic.com)

## Automated Setup

The fastest way to get started:

```bash
git clone https://github.com/dborgian/coo-assistant.git
cd coo-assistant
npm run setup
```

The interactive wizard will guide you through everything. Below are manual instructions for each integration.

---

## 1. Telegram Bot

1. Open Telegram, search **@BotFather**
2. Send `/newbot`, follow prompts, copy the **bot token**
3. Search **@userinfobot**, send `/start`, copy your **chat ID** (numeric)

## 2. Supabase Database

1. Create a project at [supabase.com](https://supabase.com)
2. Go to **Settings → Database → Connection string**
3. Select **"Session pooler"** or **"Transaction pooler"**
4. Click **"Using the Shared Pooler"** (IPv4 compatible, free)
5. Copy the connection string (format: `postgresql://postgres.[ref]:[password]@aws-...:6543/postgres`)
6. Run migrations: `npm run db:migrate`

**Important:** Use the **shared pooler** (port 6543), NOT the direct connection. This ensures IPv4 compatibility.

## 3. Anthropic (Claude AI)

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Create an API key
3. Set `ANTHROPIC_API_KEY` in `.env`

## 4. Google Workspace (Optional)

### Enable APIs
1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project (or use existing)
3. Enable these APIs:
   - Google Calendar API
   - Gmail API
   - Google Drive API
   - Google Sheets API
4. Create **OAuth 2.0 credentials** (Desktop app type)
5. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`

### Authorize
```bash
npm run google:auth
```
1. Opens browser → sign in → authorize all permissions
2. Copy the refresh token printed in terminal
3. Paste into `GOOGLE_REFRESH_TOKEN` in `.env`

### Drive Folders (Optional)
Create folders in Google Drive for report storage and set their IDs:
- `COO_DRIVE_FOLDER_ID` — Main COO reports folder
- `DRIVE_DAILY_FOLDER_ID` — Daily/weekly reports subfolder
- `DRIVE_EMPLOYEE_FOLDER_ID` — Employee reports subfolder

## 5. Slack (Optional)

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → Create New App
2. Enable **Socket Mode** → copy the **App-Level Token** (`xapp-...`)
3. Add Bot Token Scopes: `chat:write`, `channels:history`, `channels:read`, `users:read`
4. Install to workspace → copy **Bot Token** (`xoxb-...`)
5. Set in `.env`:
   - `SLACK_BOT_TOKEN` = bot token
   - `SLACK_APP_TOKEN` = app-level token
   - `SLACK_NOTIFICATIONS_CHANNEL` = channel ID for alerts

### Interactive Buttons
For Slack button actions (Complete/Snooze), also add:
- **Interactivity** → Enable → no URL needed (Socket Mode handles it)

## 6. Notion (Optional)

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Create an integration → copy the **API key**
3. In Notion, open your Tasks database → Share → Invite the integration
4. Copy the database ID from the URL (the long UUID after the workspace name)
5. Set in `.env`:
   - `NOTION_API_KEY`
   - `NOTION_TASKS_DATABASE_ID`
   - `NOTION_PROJECTS_DATABASE_ID` (optional)

## 7. Telegram Chat Monitoring (Optional)

This uses GramJS to monitor group chats as a userbot.

1. Go to [my.telegram.org](https://my.telegram.org) → API Development Tools
2. Copy **API ID** and **API Hash**
3. Run:
```bash
npm run gramjs:login
```
4. Enter your phone number and verification code
5. Copy the session string into `TELEGRAM_SESSION_STRING` in `.env`

---

## Running

### Development
```bash
npm run dev
```

### Production
```bash
npm run build
npm start
```

### Docker
```bash
docker-compose up -d
```

### PM2
```bash
npm run build
pm2 start ecosystem.config.cjs
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Bot doesn't respond | Check `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_CHAT_ID` |
| Database error | Verify `SUPABASE_DB_URL` uses shared pooler (port 6543) |
| Google 403 error | Run `npm run google:auth` and authorize all scopes |
| Sheets API disabled | Enable at Google Cloud Console → APIs → Google Sheets API |
| Slack not connecting | Verify Socket Mode is enabled and tokens are correct |
| Notion sync fails | Make sure databases are shared with the integration |
| GramJS login fails | Use phone number with country code (+39...) |
| drizzle-kit push crash | Use `npm run db:migrate` instead (manual SQL) |
| WSL IPv6 error | Use Supabase shared pooler (IPv4 compatible) |
