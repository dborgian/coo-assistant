from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from src.models.database import Base


class DailyReport(Base):
    __tablename__ = "daily_reports"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    report_date: Mapped[str] = mapped_column(String(10), nullable=False)  # YYYY-MM-DD
    report_type: Mapped[str] = mapped_column(String(50), default="daily")  # daily, weekly, on_demand
    content: Mapped[str] = mapped_column(Text, nullable=False)
    sent_via: Mapped[str] = mapped_column(String(50), default="telegram")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
