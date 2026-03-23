import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../utils/logger.js";

const MCP_CONFIG_PATH = resolve(import.meta.dirname, "../../config/mcp_servers.json");

interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

class MCPClientManager {
  config: McpConfig = { mcpServers: {} };
  private loaded = false;

  loadConfig(): McpConfig {
    if (existsSync(MCP_CONFIG_PATH)) {
      const raw = readFileSync(MCP_CONFIG_PATH, "utf-8");
      this.config = JSON.parse(raw);
      this.loaded = true;
      logger.info(
        { servers: Object.keys(this.config.mcpServers) },
        "MCP config loaded",
      );
    } else {
      logger.warn({ path: MCP_CONFIG_PATH }, "No MCP config found");
      this.config = { mcpServers: {} };
    }
    return this.config;
  }

  getServerConfig(serverName: string): McpServerConfig | undefined {
    return this.config.mcpServers[serverName];
  }

  get availableServers(): string[] {
    return Object.keys(this.config.mcpServers);
  }
}

export const mcpManager = new MCPClientManager();
