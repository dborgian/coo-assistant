from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from src.models.database import Base


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(50), default="pending")  # pending, in_progress, done, cancelled
    priority: Mapped[str] = mapped_column(String(20), default="medium")  # low, medium, high, urgent
    assigned_to: Mapped[int | None] = mapped_column(Integer, ForeignKey("employees.id"), nullable=True)
    client_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("clients.id"), nullable=True)
    due_date: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    reminder_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    reminder_sent: Mapped[bool] = mapped_column(default=False)
    source: Mapped[str | None] = mapped_column(String(50), nullable=True)  # manual, kanbanchi, calendar
    external_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
