# COO Assistant

AI-powered Chief Operating Officer assistant for internal startup operations. Communicates via Telegram, integrates with Google Calendar, Gmail, and Kanbanchi through MCP servers, and uses Claude for intelligent decision-making.

## Features

- **Telegram Bot** — Bidirectional communication with the founder
- **Chat Monitoring** — Monitors Telegram groups and DMs, classifies urgency, notifies when replies are needed
- **Daily Reports** — Automated morning operations reports
- **Task Management** — Track tasks, set reminders, assign to team members
- **Calendar Sync** — Google Calendar integration via MCP (upcoming events, conflict detection)
- **Email Triage** — Gmail integration via MCP (important email flagging)
- **Kanbanchi Sync** — Project board monitoring and overdue task alerts
- **AI Brain** — Claude-powered reasoning for message classification, report generation, and query answering

## Architecture

Built on the Anthropic SDK with MCP (Model Context Protocol) for external tool integration:

```
Telegram Bot (grammY) + GramJS Userbot
         |
    Service Layer (chat monitor, reports, reminders, calendar, email)
         |
    Anthropic SDK (AI reasoning)
         |
    MCP Servers (Google Calendar, Gmail) + Direct APIs (Kanbanchi)
         |
    SQLite Database (better-sqlite3 + Drizzle ORM)
```

## Tech Stack

- **Runtime:** Node.js 20+ / TypeScript
- **Telegram Bot:** grammY
- **Telegram Userbot:** GramJS (chat monitoring)
- **AI:** @anthropic-ai/sdk
- **MCP:** @modelcontextprotocol/sdk
- **Database:** SQLite via better-sqlite3 + Drizzle ORM
- **Scheduler:** node-cron
- **Validation:** Zod
- **Logging:** Pino

## Quick Start

### 1. Prerequisites

- Node.js 20+
- Telegram Bot Token (from [@BotFather](https://t.me/botfather))
- GramJS API credentials (from [my.telegram.org](https://my.telegram.org))
- Anthropic API key
- Google Cloud project with Calendar & Gmail APIs enabled (for MCP)

### 2. Install

```bash
git clone https://github.com/dborgian/coo-assistant.git
cd coo-assistant
npm install
```

### 3. Configure

```bash
cp .env.example .env
# Edit .env with your credentials
```

### 4. Run

```bash
# Development (with hot reload)
npm run dev

# Production
npm run build && npm start
```

### 5. Talk to your COO

Open Telegram and send `/start` to your bot.

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Initialize the bot |
| `/status` | Operations overview |
| `/report` | Generate on-demand report |
| `/tasks` | List active tasks |
| `/remind [person] [task]` | Set a reminder |
| `/add_employee [name] [email] [role]` | Add team member |
| `/add_client [name] [company] [email]` | Add client |
| `/monitor add/list` | Configure chat monitoring |
| Any text message | Free-form COO query |

## MCP Server Setup

Configure MCP servers in `config/mcp_servers.json`. The assistant uses these for Google Calendar and Gmail access.

## Development

```bash
npm install
npm run dev       # Watch mode
npm run lint      # ESLint
npm test          # Vitest
```

## Database

Uses Drizzle ORM with SQLite. To generate migrations:

```bash
npx drizzle-kit generate
npx drizzle-kit push
```

## License

Private — internal use only.
