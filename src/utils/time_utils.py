from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from src.config import settings


def now_local() -> datetime:
    return datetime.now(ZoneInfo(settings.timezone))


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def format_time(dt: datetime) -> str:
    return dt.strftime("%H:%M")


def format_date(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d")


def format_datetime(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M")
