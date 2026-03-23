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

Built on the Claude Agent SDK with MCP (Model Context Protocol) for external tool integration:

```
Telegram Bot (PTB) + Telethon Userbot
         |
    Service Layer (chat monitor, reports, reminders, calendar, email)
         |
    Claude Agent SDK (AI reasoning)
         |
    MCP Servers (Google Calendar, Gmail) + Direct APIs (Kanbanchi)
         |
    SQLite Database (persistent state)
```

## Quick Start

### 1. Prerequisites

- Python 3.11+
- Telegram Bot Token (from [@BotFather](https://t.me/botfather))
- Telethon API credentials (from [my.telegram.org](https://my.telegram.org))
- Anthropic API key
- Google Cloud project with Calendar & Gmail APIs enabled (for MCP)

### 2. Install

```bash
git clone https://github.com/dborgian/coo-assistant.git
cd coo-assistant
pip install -e .
```

### 3. Configure

```bash
cp .env.example .env
# Edit .env with your credentials
```

### 4. Run

```bash
python -m src.main
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
pip install -e ".[dev]"
pytest
```

## License

Private — internal use only.
