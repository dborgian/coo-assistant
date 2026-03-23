from __future__ import annotations

import json
from typing import Any

import anthropic
import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.config import settings
from src.models import Client, Employee, Task

logger = structlog.get_logger()

COO_SYSTEM_PROMPT = """\
You are the Chief Operating Officer (COO) AI assistant for a high-performance startup.

Your responsibilities:
- Monitor all communication channels and flag messages needing the founder's attention
- Track tasks, deadlines, and remind team members of their responsibilities
- Generate daily operations reports covering calendar, tasks, emails, and client status
- Manage employee and client information
- Proactively identify operational issues before they become problems
- Communicate clearly and concisely via Telegram

Your personality:
- Professional but approachable
- Proactive — don't wait to be asked, surface issues early
- Concise — founders are busy, get to the point
- Detail-oriented — nothing falls through the cracks
- High standards — operate like a top-tier startup COO

When generating reports or summaries, use clear formatting with sections and bullet points.
When notifying about urgent matters, lead with the urgency level.

You have access to the following tools to accomplish your tasks:
- Google Calendar (read/write events)
- Gmail (read/send emails)
- Kanbanchi (project board management)
- Internal database (employees, clients, tasks, message logs)
"""


class COOAgent:
    def __init__(self) -> None:
        self.client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)
        self.model = settings.agent_model
        self.conversation_history: list[dict[str, Any]] = []

    async def think(self, prompt: str, context: dict[str, Any] | None = None) -> str:
        messages = []
        if context:
            messages.append({
                "role": "user",
                "content": f"Context:\n```json\n{json.dumps(context, default=str)}\n```\n\n{prompt}",
            })
        else:
            messages.append({"role": "user", "content": prompt})

        response = await self.client.messages.create(
            model=self.model,
            max_tokens=4096,
            system=COO_SYSTEM_PROMPT,
            messages=messages,
        )
        return response.content[0].text

    async def classify_message_urgency(self, message: str, sender: str, chat_title: str) -> dict[str, Any]:
        prompt = f"""Classify this message's urgency and whether the founder needs to reply.

Sender: {sender}
Chat: {chat_title}
Message: {message}

Respond in JSON format:
{{"urgency": "low|normal|high|critical", "needs_reply": true|false, "summary": "brief summary", "reason": "why this urgency level"}}"""

        result = await self.think(prompt)
        try:
            return json.loads(result)
        except json.JSONDecodeError:
            # Try to extract JSON from the response
            start = result.find("{")
            end = result.rfind("}") + 1
            if start >= 0 and end > start:
                return json.loads(result[start:end])
            return {"urgency": "normal", "needs_reply": False, "summary": message[:100], "reason": "parse_error"}

    async def generate_daily_report(self, data: dict[str, Any]) -> str:
        prompt = f"""Generate a concise daily operations report based on the following data.
Format it nicely for Telegram (use bold, bullet points).

Data:
{json.dumps(data, default=str, indent=2)}

Include sections for:
1. Today's Calendar
2. Active Tasks & Deadlines
3. Messages Needing Attention
4. Overdue Items
5. Key Metrics / Status

If any section has no data, note it briefly and move on."""

        return await self.think(prompt)

    async def answer_query(self, query: str, session: AsyncSession) -> str:
        employees = (await session.execute(select(Employee).where(Employee.is_active))).scalars().all()
        clients = (await session.execute(select(Client).where(Client.is_active))).scalars().all()
        active_tasks = (
            await session.execute(select(Task).where(Task.status.in_(["pending", "in_progress"])))
        ).scalars().all()

        context = {
            "employees": [{"id": e.id, "name": e.name, "role": e.role} for e in employees],
            "clients": [{"id": c.id, "name": c.name, "company": c.company} for c in clients],
            "active_tasks": [
                {"id": t.id, "title": t.title, "status": t.status, "priority": t.priority, "due": str(t.due_date)}
                for t in active_tasks
            ],
        }

        return await self.think(query, context=context)


agent = COOAgent()
