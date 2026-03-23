from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

import structlog
from sqlalchemy import select

from src.config import settings
from src.models import Employee, Task
from src.models.database import async_session

logger = structlog.get_logger()


async def check_and_send_reminders(bot_app: Any) -> None:
    """Check for tasks that need reminders and send them."""
    now = datetime.now()
    upcoming_window = now + timedelta(hours=1)

    async with async_session() as session:
        # Tasks with explicit reminder times
        due_reminders = (
            await session.execute(
                select(Task).where(
                    Task.reminder_at.isnot(None),
                    Task.reminder_at <= upcoming_window,
                    Task.reminder_sent == False,  # noqa: E712
                    Task.status.in_(["pending", "in_progress"]),
                )
            )
        ).scalars().all()

        # Tasks due today that haven't been reminded
        due_today = (
            await session.execute(
                select(Task).where(
                    Task.due_date.isnot(None),
                    Task.due_date <= now + timedelta(hours=24),
                    Task.due_date >= now,
                    Task.reminder_sent == False,  # noqa: E712
                    Task.status.in_(["pending", "in_progress"]),
                )
            )
        ).scalars().all()

        tasks_to_remind = list({t.id: t for t in [*due_reminders, *due_today]}.values())

        if not tasks_to_remind:
            return

        for task in tasks_to_remind:
            assignee = None
            if task.assigned_to:
                assignee = (
                    await session.execute(select(Employee).where(Employee.id == task.assigned_to))
                ).scalar_one_or_none()

            # Notify owner
            assignee_text = f" (assigned to {assignee.name})" if assignee else ""
            due_text = f"\nDue: {task.due_date.strftime('%m/%d %H:%M')}" if task.due_date else ""
            notification = (
                f"<b>Task Reminder</b>{assignee_text}\n\n"
                f"<b>{task.title}</b>{due_text}\n"
                f"Priority: {task.priority}"
            )

            try:
                await bot_app.bot.send_message(
                    chat_id=settings.telegram_owner_chat_id,
                    text=notification,
                    parse_mode="HTML",
                )
                task.reminder_sent = True
                logger.info("Reminder sent", task=task.title, assignee=assignee.name if assignee else "unassigned")
            except Exception as e:
                logger.error("Failed to send reminder", task=task.title, error=str(e))

        await session.commit()
