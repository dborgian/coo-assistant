# COO Assistant — Usage Guide

## How to Talk to the Bot

The COO Assistant works in two modes:

### 1. Commands (slash commands)
Type `/` in Telegram to see autocomplete. Example: `/tasks`, `/report`, `/dashboard`.

### 2. Natural Language (AI mode)
Send any message without `/` and the AI will understand. Examples:
- "come vanno le cose oggi?"
- "crea un task per Marco: preparare la presentazione entro venerdi"
- "chi e' sovraccarico nel team?"
- "manda un'email a Marco per ricordargli del meeting"

The AI has full access to: tasks, calendar, email, Slack, Notion, Drive, team data.

---

## Task Management

### Create a task
```
crea un task: review del codice — priorita alta, assegnato a Marco, scadenza 28 marzo
```

### Create recurring tasks
```
crea un task ricorrente "daily standup" ogni giorno assegnato a Marco
crea un task ricorrente "weekly review" ogni lunedi e venerdi
```

### Set dependencies
```
il task "deploy" dipende da "testing"
```
The dependent task won't be escalated or scheduled until the blocker is done.

### Update task status
```
il task "review del codice" e' completato
metti il task "presentazione" in progress
```

### Schedule a task
```
schedula il task "review" nel calendario, durata 2 ore
```
The auto-scheduler will find a free slot in Google Calendar before the deadline.

### Snooze escalation
```
non escalare il task "proposta cliente" per 5 giorni
```

---

## Team Management

### Check workload
```
chi e' sovraccarico?
mostrami il carico di lavoro del team
```

### Check capacity
```
chi ha tempo per un task da 3 ore?
```

### Suggest assignment
```
a chi dovrei assegnare un task da 2 ore?
```

### Add employees/clients
```
/add_employee Marco Rossi marco@example.com Developer
/add_client Acme Inc acme@example.com
```

---

## Reports

### Daily report
```
/report
```
Or ask: "genera il report di oggi"

### PDF reports
```
genera il report giornaliero in PDF
genera il report settimanale in PDF
genera il report di Marco in PDF
```

### Report history
```
/reports
/reports 2026-03-25
```

---

## Communication

### Send email
```
manda un'email a marco@example.com con oggetto "Reminder meeting" e testo "Ci vediamo alle 15"
```

### Send Slack message
```
notifica su Slack che il deploy e' completato
manda un messaggio su Slack al canale general
```

---

## Integrations

### Google Calendar
- Events shown in daily report and dashboard
- Auto-scheduling creates events in your calendar
- Meeting action items suggested after meetings end

### Gmail
- Important unread emails flagged automatically
- Send emails via natural language

### Notion
- Two-way sync: tasks created in bot appear in Notion and vice versa
- Search Notion: "cerca su Notion il progetto alpha"

### Slack
- All messages monitored and forwarded to Telegram
- Interactive buttons on notifications (Complete / Snooze)
- AI summaries: `/slack_summary`

### Google Sheets
- Weekly metrics exported automatically to a "COO Dashboard" spreadsheet
- Tracks: tasks created/completed, team workload, overdue items

### Google Drive
- PDF reports uploaded automatically
- Search files: `/drive report` or "trova il report di ieri su Drive"

---

## Automated Behaviors

### Escalation (every 30 min)
Tasks with deadlines are escalated progressively:
- **L0** (48h before): Soft reminder on Telegram
- **L1** (24h before): Email + Slack DM to assignee
- **L2** (overdue): Alert on Telegram + email to assignee
- **L3** (3+ days overdue): Telegram + Slack channel alert
- **L4** (7+ days overdue): AI recommendation (reassign? cancel?)

### Auto-Priority (every 2 hours)
Priority automatically upgrades based on deadline:
- 3 days → medium (if was low)
- 1 day → high (if was < high)
- Overdue → urgent

### Smart Agenda (7:30 AM daily)
Each employee receives a personalized morning agenda via Telegram/email.

### Proactive AI Check (11:00 + 16:00)
The AI scans for operational risks:
- Unassigned tasks with near deadlines
- Overloaded employees
- Too many overdue tasks

### Weekly Digest (Friday 17:00)
Summary of the week: tasks completed, created, trends, suggestions for next week.

---

---

## Project Management

### Auto-create a project
```
crea un progetto per il redesign del sito web, deadline 15 aprile
```
The AI generates 5-10 tasks automatically with estimates, priorities, and dependencies.

### Check project ETA
```
qual è la data stimata di completamento del progetto redesign?
```

---

## Company Intelligence

### Team morale
```
come sta il morale del team?
```

### Unfulfilled commitments
```
chi ha promesso cosa e non l'ha fatto?
```

### Decisions made
```
quali decisioni abbiamo preso questa settimana?
```

### Knowledge base
```
cosa sappiamo del cliente Acme?
```

### Communication patterns
```
chi è silenzioso ultimamente?
quanto tempo ci mette Marco a rispondere?
```

### Trending topics
```
di cosa si parla di più in azienda?
```

### Meeting stats
```
quanti meeting ho oggi?
```

---

## Google Workspace Integration

The bot uses Google Workspace to schedule tasks in each employee's calendar. Set the employee's Google email:

```
aggiorna l'email di Marco a marco@azienda.com
```

Tasks assigned to an employee are scheduled in **their** calendar, not yours.

---

## FAQ

**Q: The bot doesn't respond to my messages.**
A: Make sure your Telegram Chat ID matches `TELEGRAM_OWNER_CHAT_ID` in `.env`.

**Q: Google Calendar/Gmail isn't working.**
A: Run `npm run google:auth` and authorize all permissions. Make sure Calendar API, Gmail API, Drive API, and Sheets API are enabled in Google Cloud Console.

**Q: Slack messages aren't being monitored.**
A: Verify Socket Mode is enabled in your Slack app. Check that `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are set.

**Q: Tasks aren't syncing with Notion.**
A: Make sure you've shared your Notion databases with the integration. Check `NOTION_TASKS_DATABASE_ID` in `.env`.

**Q: Auto-scheduling doesn't create calendar events.**
A: The task needs both `estimatedMinutes` and `dueDate`. Use: "schedula il task X, durata 2 ore"

**Q: How do I stop escalation for a task?**
A: Say "non escalare il task X per 3 giorni" or use the Snooze button in Slack.

**Q: Tasks aren't appearing in the employee's calendar.**
A: Set the employee's Google Workspace email: "aggiorna l'email di Marco a marco@azienda.com". The bot needs their email to write to their calendar.

**Q: How does auto-project creation work?**
A: Say "crea progetto X con deadline Y". The AI generates 5-10 tasks with estimates and dependencies. All tasks sync to Notion within 5 minutes.

**Q: The knowledge base is empty.**
A: Knowledge accumulates over time from conversations. It needs at least a few days of Slack/Telegram messages to extract useful facts.
