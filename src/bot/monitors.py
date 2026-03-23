from __future__ import annotations

import asyncio
from typing import Any

import structlog
from telethon import TelegramClient, events

from src.config import settings
from src.core.agent import agent
from src.models.database import async_session
from src.models.message_log import MessageLog

logger = structlog.get_logger()

_userbot: TelegramClient | None = None
_bot_app: Any = None


async def start_userbot(bot_app: Any) -> TelegramClient | None:
    global _userbot, _bot_app
    _bot_app = bot_app

    if not settings.telethon_api_id or not settings.telethon_api_hash:
        logger.warning("Telethon credentials not configured — chat monitoring disabled")
        return None

    _userbot = TelegramClient(
        settings.telethon_session_name,
        settings.telethon_api_id,
        settings.telethon_api_hash,
    )

    await _userbot.start()
    logger.info("Telethon userbot started")

    @_userbot.on(events.NewMessage)
    async def handle_new_message(event: events.NewMessage.Event) -> None:
        chat_id = event.chat_id

        # Only process messages from monitored chats
        if settings.monitored_chat_ids and chat_id not in settings.monitored_chat_ids:
            return

        # Skip our own messages
        if event.out:
            return

        sender = await event.get_sender()
        chat = await event.get_chat()
        sender_name = getattr(sender, "first_name", "") or getattr(sender, "title", "Unknown")
        chat_title = getattr(chat, "title", None) or sender_name
        message_text = event.message.text or ""

        if not message_text.strip():
            return

        logger.info(
            "New message detected",
            chat=chat_title,
            sender=sender_name,
            preview=message_text[:80],
        )

        # Use AI to classify urgency
        classification = await agent.classify_message_urgency(message_text, sender_name, chat_title)

        async with async_session() as session:
            msg_log = MessageLog(
                source="telegram",
                chat_id=chat_id,
                chat_title=chat_title,
                sender_name=sender_name,
                sender_id=getattr(sender, "id", None),
                content=message_text,
                urgency=classification.get("urgency", "normal"),
                needs_reply=classification.get("needs_reply", False),
            )
            session.add(msg_log)
            await session.commit()

        # Notify owner if high urgency or needs reply
        if classification.get("needs_reply") or classification.get("urgency") in ("high", "critical"):
            urgency = classification.get("urgency", "normal").upper()
            summary = classification.get("summary", message_text[:150])
            notification = (
                f"<b>[{urgency}] New message needs attention</b>\n\n"
                f"<b>Chat:</b> {chat_title}\n"
                f"<b>From:</b> {sender_name}\n"
                f"<b>Summary:</b> {summary}\n"
                f"<b>Reason:</b> {classification.get('reason', 'N/A')}"
            )
            try:
                await _bot_app.bot.send_message(
                    chat_id=settings.telegram_owner_chat_id,
                    text=notification,
                    parse_mode="HTML",
                )
                msg_log.notified_owner = True
            except Exception as e:
                logger.error("Failed to notify owner", error=str(e))

    return _userbot


async def stop_userbot() -> None:
    global _userbot
    if _userbot:
        await _userbot.disconnect()
        _userbot = None
        logger.info("Telethon userbot stopped")
