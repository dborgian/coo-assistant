from __future__ import annotations

from typing import Any

import structlog

logger = structlog.get_logger()


class GmailIntegration:
    """Wrapper for Gmail operations via MCP server.

    When the Gmail MCP server is configured, this class
    provides typed methods that translate to MCP tool calls.
    """

    def __init__(self, mcp_client: Any = None) -> None:
        self.mcp = mcp_client

    async def get_unread_important(self) -> list[dict[str, Any]]:
        """Fetch unread important emails."""
        if not self.mcp:
            logger.warning("Gmail MCP not configured")
            return []
        # TODO: Call MCP tool
        return []

    async def search_emails(self, query: str) -> list[dict[str, Any]]:
        """Search emails with Gmail query syntax."""
        if not self.mcp:
            return []
        return []

    async def send_email(self, to: str, subject: str, body: str) -> bool:
        """Send an email."""
        if not self.mcp:
            logger.warning("Gmail MCP not configured")
            return False
        # TODO: Call MCP tool
        return False
