from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

import structlog
from sqlalchemy import select

from src.config import settings
from src.core.agent import agent
from src.models.database import async_session
from src.models.message_log import MessageLog

logger = structlog.get_logger()


async def check_pending_messages(bot_app: Any) -> None:
    """Periodic check for messages that still need replies."""
    async with async_session() as session:
        stale_threshold = datetime.now() - timedelta(hours=2)
        stale_messages = (
            await session.execute(
                select(MessageLog).where(
                    MessageLog.needs_reply == True,  # noqa: E712
                    MessageLog.replied == False,  # noqa: E712
                    MessageLog.notified_owner == True,  # noqa: E712
                    MessageLog.received_at < stale_threshold,
                )
            )
        ).scalars().all()

        if not stale_messages:
            return

        reminder_text = "<b>Pending Reply Reminder</b>\n\n"
        for msg in stale_messages:
            age = datetime.now() - msg.received_at
            hours = int(age.total_seconds() / 3600)
            reminder_text += (
                f"- <b>{msg.chat_title}</b> from {msg.sender_name} "
                f"({hours}h ago): {msg.content[:100]}...\n"
            )

        try:
            await bot_app.bot.send_message(
                chat_id=settings.telegram_owner_chat_id,
                text=reminder_text,
                parse_mode="HTML",
            )
            logger.info("Sent pending reply reminder", count=len(stale_messages))
        except Exception as e:
            logger.error("Failed to send reminder", error=str(e))
