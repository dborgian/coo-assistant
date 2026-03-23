from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from src.models.database import Base


class MessageLog(Base):
    __tablename__ = "message_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    source: Mapped[str] = mapped_column(String(50), nullable=False)  # telegram, gmail, kanbanchi
    chat_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    chat_title: Mapped[str | None] = mapped_column(String(200), nullable=True)
    sender_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    sender_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    urgency: Mapped[str] = mapped_column(String(20), default="normal")  # low, normal, high, critical
    needs_reply: Mapped[bool] = mapped_column(Boolean, default=False)
    replied: Mapped[bool] = mapped_column(Boolean, default=False)
    notified_owner: Mapped[bool] = mapped_column(Boolean, default=False)
    received_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
