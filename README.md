# COO Assistant

AI-powered Chief Operating Officer for startup operations. Orchestrates Google Workspace, Slack, Notion, and Telegram through a single AI interface — no native tools, everything via integrations.

## What It Does

- **Talk naturally** — Send any message to the Telegram bot and the AI COO answers with full operational context
- **20 AI tools** — Create tasks, send emails, manage team, generate reports, schedule work — all via chat
- **19 automated jobs** — Escalation, auto-scheduling, daily agendas, risk detection, weekly digests
- **9 integrations** — Google Calendar (R/W), Gmail, Drive, Sheets, Slack, Telegram, Notion, Supabase, Claude AI

## Architecture

```
                    Telegram (grammY + GramJS)
                           │
              ┌────────────┼────────────┐
              │            │            │
         Bot Commands   AI Agent    Chat Monitor
         (18+ cmds)    (20 tools)   (userbot)
              │            │            │
              └────────────┼────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
    Google APIs      Slack (bolt)       Notion API
  Calendar/Gmail/    Socket Mode        Tasks/Projects
  Drive/Sheets       Interactive        Two-way sync
         │                 │                 │
         └─────────────────┼─────────────────┘
                           │
                    Supabase (PostgreSQL)
                    6 tables + Drizzle ORM
```

## Quick Start

```bash
git clone https://github.com/dborgian/coo-assistant.git
cd coo-assistant
npm run setup     # Interactive setup — configures everything
```

That's it. The setup script will:
1. Install dependencies
2. Ask for your credentials (Telegram, Anthropic, Supabase)
3. Optionally configure Google, Slack, Notion
4. Run database migrations
5. Start the bot

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message |
| `/help` | Full command reference |
| `/dashboard` | Interactive dashboard with inline buttons |
| `/status` | Quick operations overview |
| `/report` | Generate AI operations report |
| `/report_pdf` | Generate PDF report (daily/weekly) |
| `/reports [date]` | View report history |
| `/employee_report [name]` | PDF report for an employee |
| `/tasks [overdue]` | List active tasks |
| `/slack_report` | Slack digest by channel |
| `/slack_summary` | AI summary of Slack conversations |
| `/slack add/list/remove` | Manage monitored Slack channels |
| `/remind [person] [task]` | Create a reminder |
| `/add_employee [name] [email] [role]` | Add team member |
| `/add_client [name] [company] [email]` | Add client |
| `/monitor add/list` | Configure Telegram monitoring |
| `/notion` | Notion workspace summary |
| `/drive [query]` | Search Google Drive files |
| Any text | Free-form AI query |

## AI Tools (via natural language)

| Tool | Example prompt |
|------|----------------|
| Create task | "crea un task per Marco: review del codice entro venerdi" |
| Recurring task | "crea un task ricorrente daily standup ogni giorno" |
| Set dependency | "il task deploy dipende da testing" |
| Schedule task | "schedula il task review nel calendario, durata 2 ore" |
| Update status | "il task X e' completato" |
| Send email | "manda un reminder a Marco via email" |
| Send Slack | "notifica il team su Slack che il deploy e' fatto" |
| Team workload | "chi e' sovraccarico nel team?" |
| Team capacity | "chi ha tempo per un task da 3 ore?" |
| Suggest assignment | "a chi dovrei assegnare questo task?" |
| Snooze escalation | "non escalare il task X per 5 giorni" |
| Generate PDF | "genera il report settimanale in PDF" |
| Notion search | "cerca su Notion il progetto alpha" |
| Drive search | "trova il report di ieri su Drive" |

## Automated Jobs (19 cron jobs)

| Time | Job | What it does |
|------|-----|--------------|
| 00:05 | Recurring Tasks | Generates daily/weekly/monthly task instances |
| 07:30 | Smart Agenda | Sends personalized AI agenda to each employee |
| 08:00 | Daily Report | AI operations report via Telegram |
| Mon 08:00 | Sheets Export | Exports metrics to Google Sheets dashboard |
| Mon 09:00 | Client Updates | Sends weekly status email to each client |
| 09:00 | Stale Detection | Alerts on stuck tasks (3+ days without update) |
| 11:00, 16:00 | Proactive Check | AI risk detection and action suggestions |
| Fri 17:00 | Weekly Digest | Trend analysis and next-week priorities |
| 23:30 | Workload Metrics | Calculates daily employee performance scores |
| Every 5 min | Chat Monitor | Checks for pending replies |
| Every 10 min | Email Check | Flags important unread Gmail |
| Every 10 min | Task Reminders | Due date notifications |
| Every 15 min | Calendar Check | Meeting alerts + conflict detection |
| Every 15 min | Notion Sync | Syncs Notion workspace |
| Every 30 min | Escalation | Progressive L0-L4 task escalation |
| Every 30 min | Meeting Actions | Suggests action items after meetings |
| Every 30 min | Notion Two-Way | Syncs tasks bidirectionally with Notion |
| Every 2 hours | Auto-Priority | Upgrades task priority based on deadline |
| Every 4 hours | Auto-Scheduling | Places tasks into Google Calendar free slots |

## Deployment

### Development
```bash
npm run dev          # Hot reload with tsx
```

### Production (Node.js)
```bash
npm run build        # Compile TypeScript
npm start            # Run compiled code
```

### Production (PM2)
```bash
npm run build
pm2 start ecosystem.config.cjs
```

### Production (Docker)
```bash
docker-compose up -d
```

## Scripts

| Script | Description |
|--------|-------------|
| `npm run setup` | Interactive setup wizard |
| `npm run dev` | Development with hot reload |
| `npm run build` | Compile TypeScript |
| `npm start` | Run production build |
| `npm test` | Run tests (watch mode) |
| `npm run test:run` | Run tests once |
| `npm run type-check` | TypeScript check without build |
| `npm run db:migrate` | Run database migrations |
| `npm run google:auth` | Google OAuth setup |
| `npm run gramjs:login` | GramJS session setup |
| `npm run lint` | ESLint |

## Documentation

- **[USAGE.md](docs/USAGE.md)** — Daily usage guide with examples
- **[DEMO.md](docs/DEMO.md)** — Step-by-step demo walkthrough
- **[SETUP.md](docs/SETUP.md)** — Detailed setup instructions

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 20+ / TypeScript |
| Telegram Bot | grammY |
| Telegram Monitoring | GramJS |
| AI | Anthropic Claude (claude-sonnet) |
| Database | PostgreSQL (Supabase) + Drizzle ORM |
| Slack | @slack/bolt (Socket Mode) |
| Google APIs | googleapis (Calendar, Gmail, Drive, Sheets) |
| Notion | @notionhq/client |
| PDF Reports | PDFKit |
| Scheduler | node-cron |
| Logging | Pino |
| Validation | Zod |
| Testing | Vitest |

## License

Private — internal use only.
