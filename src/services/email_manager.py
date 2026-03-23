from __future__ import annotations

from typing import Any

import structlog

from src.config import settings

logger = structlog.get_logger()


async def check_important_emails(bot_app: Any) -> None:
    """Check Gmail for important/urgent emails via MCP.

    This service will use the Gmail MCP server when configured.
    The flow will be:
    1. Call MCP tool: gmail.list_messages(query="is:unread is:important")
    2. For each important unread email, classify urgency via AI
    3. Notify owner of urgent emails
    4. Log to message_logs table
    """
    # TODO: Integrate with Gmail MCP server
    logger.debug("Email check — MCP integration pending setup")
