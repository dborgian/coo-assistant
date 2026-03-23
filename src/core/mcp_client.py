from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import structlog

logger = structlog.get_logger()

MCP_CONFIG_PATH = Path(__file__).parent.parent.parent / "config" / "mcp_servers.json"


class MCPClientManager:
    """Manages connections to MCP servers for external tool access.

    This is a thin coordination layer. Actual MCP server connections
    are established when the Agent SDK initializes with the server configs.
    For direct API calls (like Kanbanchi), this provides helper methods.
    """

    def __init__(self) -> None:
        self.config: dict[str, Any] = {}
        self._loaded = False

    def load_config(self) -> dict[str, Any]:
        if MCP_CONFIG_PATH.exists():
            with open(MCP_CONFIG_PATH) as f:
                self.config = json.load(f)
            self._loaded = True
            logger.info("MCP config loaded", servers=list(self.config.get("mcpServers", {}).keys()))
        else:
            logger.warning("No MCP config found", path=str(MCP_CONFIG_PATH))
            self.config = {"mcpServers": {}}
        return self.config

    def get_server_config(self, server_name: str) -> dict[str, Any] | None:
        return self.config.get("mcpServers", {}).get(server_name)

    @property
    def available_servers(self) -> list[str]:
        return list(self.config.get("mcpServers", {}).keys())


mcp_manager = MCPClientManager()
