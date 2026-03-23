from __future__ import annotations

from datetime import datetime
from typing import Any

import structlog
from sqlalchemy import func, select

from src.config import settings
from src.core.agent import agent
from src.models import DailyReport, MessageLog, Task
from src.models.database import async_session

logger = structlog.get_logger()


async def generate_and_send_daily_report(bot_app: Any) -> None:
    """Generate and send the daily operations report."""
    today = datetime.now().strftime("%Y-%m-%d")
    logger.info("Generating daily report", date=today)

    async with async_session() as session:
        # Gather data
        active_tasks = (
            await session.execute(
                select(Task).where(Task.status.in_(["pending", "in_progress"]))
            )
        ).scalars().all()

        overdue_tasks = [t for t in active_tasks if t.due_date and t.due_date < datetime.now()]

        pending_messages = (
            await session.execute(
                select(MessageLog).where(
                    MessageLog.needs_reply == True,  # noqa: E712
                    MessageLog.replied == False,  # noqa: E712
                )
            )
        ).scalars().all()

        today_messages = (
            await session.execute(
                select(func.count(MessageLog.id)).where(
                    func.date(MessageLog.received_at) == today,
                )
            )
        ).scalar() or 0

        report_data = {
            "date": today,
            "active_tasks": [
                {
                    "title": t.title,
                    "status": t.status,
                    "priority": t.priority,
                    "due": str(t.due_date) if t.due_date else None,
                }
                for t in active_tasks
            ],
            "overdue_tasks": [
                {"title": t.title, "priority": t.priority, "due": str(t.due_date)}
                for t in overdue_tasks
            ],
            "pending_replies": [
                {
                    "sender": m.sender_name,
                    "chat": m.chat_title,
                    "urgency": m.urgency,
                    "received": str(m.received_at),
                }
                for m in pending_messages
            ],
            "messages_today": today_messages,
            "summary": {
                "total_active_tasks": len(active_tasks),
                "overdue_count": len(overdue_tasks),
                "pending_replies": len(pending_messages),
            },
        }

        # Generate report via AI
        report_content = await agent.generate_daily_report(report_data)

        # Save to DB
        report = DailyReport(
            report_date=today,
            report_type="daily",
            content=report_content,
        )
        session.add(report)
        await session.commit()

    # Send via Telegram
    try:
        if len(report_content) > 4000:
            for i in range(0, len(report_content), 4000):
                await bot_app.bot.send_message(
                    chat_id=settings.telegram_owner_chat_id,
                    text=report_content[i : i + 4000],
                )
        else:
            await bot_app.bot.send_message(
                chat_id=settings.telegram_owner_chat_id,
                text=report_content,
            )
        logger.info("Daily report sent", date=today)
    except Exception as e:
        logger.error("Failed to send daily report", error=str(e))
