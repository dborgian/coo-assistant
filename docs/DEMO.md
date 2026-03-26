# COO Assistant — Demo Walkthrough

This guide walks through every major feature of the COO Assistant step by step. Follow along to test all functionality.

**Prerequisites:** The bot is running (`npm run dev`) and you can message it on Telegram.

---

## 1. First Contact

**Send:** `/start`

**Expected:** Welcome message with feature overview and command list.

**Send:** `/help`

**Expected:** Full command reference with descriptions.

---

## 2. Dashboard

**Send:** `/dashboard`

**Expected:** Overview with live stats (tasks, Slack messages, emails, calendar events) and inline keyboard buttons: [Tasks] [Slack] [Email] [Calendar] [Kanbanchi] [Report] [History].

**Click:** [Tasks] button

**Expected:** Task list displayed in-place. [← Dashboard] button to go back.

---

## 3. Add Team Members

**Send:** `/add_employee Marco Rossi marco@example.com Developer`

**Expected:** "Employee Marco Rossi aggiunto" confirmation.

**Send:** `/add_employee Anna Bianchi anna@example.com Designer`

**Expected:** Second employee added.

---

## 4. Add a Client

**Send:** `/add_client Acme Corp acme@example.com`

**Expected:** Client added confirmation.

---

## 5. Create Tasks

**Send:** `crea un task: review del codice, priorita alta, assegnato a Marco, scadenza domani`

**Expected:** AI confirms task created, assigned to Marco, Slack notification sent.

**Send:** `crea un task: design della landing page, assegnato ad Anna, scadenza tra 3 giorni`

**Expected:** Second task created.

**Send:** `crea un task: deploy in produzione, priorita urgente, scadenza tra 5 giorni`

**Expected:** Third task (unassigned).

---

## 6. Task Dependencies

**Send:** `il task deploy dipende dal task review del codice`

**Expected:** "Dipendenza impostata: deploy bloccato da review del codice"

**Send:** `il task review del codice e' completato`

**Expected:** "Task aggiornato a done. Task deploy sbloccato!"

---

## 7. Recurring Tasks

**Send:** `crea un task ricorrente "daily standup" ogni giorno assegnato a Marco`

**Expected:** Recurring task template created. New instances generated daily at 00:05.

---

## 8. Check Workload

**Send:** `chi e' sovraccarico nel team?`

**Expected:** AI shows workload for each employee with color indicators (green/yellow/red) and scores.

**Send:** `chi ha tempo per un task da 2 ore?`

**Expected:** AI suggests the least loaded employee with available hours.

---

## 9. Schedule a Task

**Send:** `schedula il task design della landing page nel calendario, durata 3 ore`

**Expected:** "Task pronto per auto-scheduling (durata: 180 min)." The next auto-scheduling cycle (every 4h) will place it in a free Google Calendar slot.

---

## 10. Snooze Escalation

**Send:** `non escalare il task deploy per 3 giorni`

**Expected:** "Escalation per deploy in pausa fino al [date]."

---

## 11. Generate Reports

**Send:** `/report`

**Expected:** AI-generated daily operations report with narrative, metrics, and data from all integrations.

**Send:** `genera il report settimanale in PDF`

**Expected:** PDF file sent in chat + uploaded to Google Drive.

**Send:** `genera il report di Marco in PDF`

**Expected:** Employee-specific PDF with activity, tasks, communication summary.

---

## 12. Report History

**Send:** `/reports`

**Expected:** List of recent reports with dates.

---

## 13. Slack Integration

**Send:** `/slack_report`

**Expected:** Raw Slack digest organized by channel (last 24h).

**Send:** `/slack_summary`

**Expected:** AI-generated summary of Slack conversations with key decisions and actions.

---

## 14. Email

**Send:** `manda un'email a marco@example.com con oggetto "Test COO" e testo "Questo e' un test del COO Assistant"`

**Expected:** "Email inviata a marco@example.com" confirmation.

---

## 15. Notion

**Send:** `/notion`

**Expected:** Notion workspace summary with tasks, projects, overdue alerts.

**Send:** `cerca su Notion il progetto alpha`

**Expected:** Search results from Notion.

---

## 16. Google Drive

**Send:** `/drive`

**Expected:** List of recent files in COO Drive folder.

**Send:** `/drive report`

**Expected:** Files matching "report" in Drive.

---

## 17. Calendar

**Send:** `quali eventi ho oggi?`

**Expected:** AI lists today's calendar events with times and locations.

---

## 18. Status Overview

**Send:** `/status`

**Expected:** Quick overview: active tasks, overdue count, pending messages, team count, client count.

---

## 19. View Active Tasks

**Send:** `/tasks`

**Expected:** All active tasks with status, priority, assignee, due date.

**Send:** `/tasks overdue`

**Expected:** Only overdue tasks.

---

## 20. Automated Features (observe over time)

These run automatically — check Telegram for notifications:

| Feature | When | What to expect |
|---------|------|----------------|
| Smart Agenda | 7:30 AM | Personalized agenda for each employee |
| Daily Report | 8:00 AM | Full AI operations report |
| Stale Detection | 9:00 AM | Alert if tasks are stuck 3+ days |
| Proactive Check | 11:00 AM, 4:00 PM | Risk detection and suggestions |
| Weekly Digest | Friday 5:00 PM | Week summary with trends |
| Auto-Priority | Every 2h | Priority auto-upgrade notifications |
| Escalation | Every 30 min | Progressive alerts for deadlines |
| Meeting Actions | Every 30 min | Action item suggestions after meetings |

---

## Summary

After completing this demo you've tested:
- 18+ bot commands
- 14+ AI tools via natural language
- Task lifecycle (create → assign → dependency → schedule → complete)
- Team management and workload analysis
- Multi-channel communication (Telegram, Email, Slack)
- Report generation (text + PDF)
- All major integrations (Google, Slack, Notion)

For daily usage reference, see **[USAGE.md](USAGE.md)**.
