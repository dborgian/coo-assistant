from __future__ import annotations

import structlog
from telegram.ext import Application, CommandHandler, MessageHandler, filters

from src.bot.commands import (
    add_client_command,
    add_employee_command,
    ask_command,
    help_command,
    monitor_command,
    remind_command,
    report_command,
    start_command,
    status_command,
    tasks_command,
)
from src.config import settings

logger = structlog.get_logger()


def create_bot() -> Application:
    app = Application.builder().token(settings.telegram_bot_token).build()

    # Only allow the owner to interact
    owner_filter = filters.User(user_id=settings.telegram_owner_chat_id)

    app.add_handler(CommandHandler("start", start_command, filters=owner_filter))
    app.add_handler(CommandHandler("help", help_command, filters=owner_filter))
    app.add_handler(CommandHandler("status", status_command, filters=owner_filter))
    app.add_handler(CommandHandler("report", report_command, filters=owner_filter))
    app.add_handler(CommandHandler("tasks", tasks_command, filters=owner_filter))
    app.add_handler(CommandHandler("remind", remind_command, filters=owner_filter))
    app.add_handler(CommandHandler("add_employee", add_employee_command, filters=owner_filter))
    app.add_handler(CommandHandler("add_client", add_client_command, filters=owner_filter))
    app.add_handler(CommandHandler("monitor", monitor_command, filters=owner_filter))

    # Free-form messages go to the AI agent
    app.add_handler(MessageHandler(owner_filter & filters.TEXT & ~filters.COMMAND, ask_command))

    logger.info("Telegram bot configured", owner_id=settings.telegram_owner_chat_id)
    return app


async def send_owner_message(app: Application, text: str, parse_mode: str = "HTML") -> None:
    await app.bot.send_message(
        chat_id=settings.telegram_owner_chat_id,
        text=text,
        parse_mode=parse_mode,
    )
