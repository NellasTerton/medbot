import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export declare const SERVER_NAME: string;
export declare const SERVER_VERSION: string;

/** Собирает MCP-сервер с тулами search_knowledge_base и submit_booking. */
export declare function createClinicMcpServer(): McpServer;
