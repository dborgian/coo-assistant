from __future__ import annotations

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from src.config import settings

scheduler = AsyncIOScheduler(timezone=settings.timezone)


def setup_schedules(
    daily_report_callback,
    chat_monitor_callback,
    calendar_check_callback,
    task_reminder_callback,
) -> None:
    # Daily operations report
    scheduler.add_job(
        daily_report_callback,
        CronTrigger(hour=settings.daily_report_hour, minute=settings.daily_report_minute),
        id="daily_report",
        name="Daily Operations Report",
        replace_existing=True,
    )

    # Chat monitoring
    scheduler.add_job(
        chat_monitor_callback,
        IntervalTrigger(minutes=settings.chat_check_interval_minutes),
        id="chat_monitor",
        name="Chat Monitor",
        replace_existing=True,
    )

    # Calendar conflict check
    scheduler.add_job(
        calendar_check_callback,
        IntervalTrigger(minutes=settings.calendar_check_interval_minutes),
        id="calendar_check",
        name="Calendar Check",
        replace_existing=True,
    )

    # Task reminder check (every 10 minutes)
    scheduler.add_job(
        task_reminder_callback,
        IntervalTrigger(minutes=10),
        id="task_reminders",
        name="Task Reminders",
        replace_existing=True,
    )
