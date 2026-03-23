from __future__ import annotations

import asyncio
import signal
import sys
from functools import partial

import structlog

structlog.configure(
    processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.add_log_level,
        structlog.dev.ConsoleRenderer(),
    ],
)

logger = structlog.get_logger()


async def run() -> None:
    from src.bot.monitors import start_userbot, stop_userbot
    from src.bot.telegram_bot import create_bot
    from src.core.mcp_client import mcp_manager
    from src.core.scheduler import scheduler, setup_schedules
    from src.models.database import init_db
    from src.services.calendar_sync import check_upcoming_events
    from src.services.chat_monitor import check_pending_messages
    from src.services.daily_reporter import generate_and_send_daily_report
    from src.services.task_reminder import check_and_send_reminders

    logger.info("Starting COO Assistant...")

    # Initialize database
    await init_db()
    logger.info("Database initialized")

    # Load MCP config
    mcp_manager.load_config()

    # Create Telegram bot
    bot_app = create_bot()

    # Setup scheduled jobs (bind bot_app to callbacks)
    setup_schedules(
        daily_report_callback=partial(generate_and_send_daily_report, bot_app),
        chat_monitor_callback=partial(check_pending_messages, bot_app),
        calendar_check_callback=partial(check_upcoming_events, bot_app),
        task_reminder_callback=partial(check_and_send_reminders, bot_app),
    )

    # Start scheduler
    scheduler.start()
    logger.info("Scheduler started")

    # Start Telethon userbot for chat monitoring
    userbot = await start_userbot(bot_app)
    if userbot:
        logger.info("Chat monitoring active")

    # Start the Telegram bot (blocking)
    logger.info("COO Assistant is online. Telegram bot starting...")
    await bot_app.initialize()
    await bot_app.start()
    await bot_app.updater.start_polling()

    # Keep running until interrupted
    stop_event = asyncio.Event()

    def _signal_handler():
        stop_event.set()

    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, _signal_handler)

    await stop_event.wait()

    # Cleanup
    logger.info("Shutting down...")
    scheduler.shutdown()
    await stop_userbot()
    await bot_app.updater.stop()
    await bot_app.stop()
    await bot_app.shutdown()
    logger.info("COO Assistant stopped.")


def main() -> None:
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
