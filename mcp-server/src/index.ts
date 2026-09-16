#!/usr/bin/env node
// Локальный вход MCP-сервера клиники: транспорт stdio для Claude Desktop.
// Сами тулы описаны в ../../concierge-api/lib/mcp-tools.js — тот же модуль
// поднимает удалённый вариант concierge-api/api/mcp.js на Vercel.
//
// stdout занят JSON-RPC, поэтому любые логи идут только в stderr.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  createClinicMcpServer,
  SERVER_NAME,
  SERVER_VERSION,
} from "../../concierge-api/lib/mcp-tools.js";
import { loadClinicEnv, missingEnv, CONCIERGE_DIR } from "./env.js";

// Ключи читаются лениво, в момент вызова инструмента, поэтому .env достаточно
// загрузить до запуска транспорта.
const loadedEnvFiles = loadClinicEnv();

async function main() {
  const missing = missingEnv();
  if (missing.length > 0) {
    console.error(
      `[${SERVER_NAME}] Не заданы переменные окружения: ${missing.join(", ")}. ` +
        `Проверьте .env.local или .env в ${CONCIERGE_DIR} либо блок "env" в claude_desktop_config.json.`,
    );
  }
  console.error(
    `[${SERVER_NAME}] .env: ${loadedEnvFiles.length > 0 ? loadedEnvFiles.join(", ") : "не найден, используется окружение процесса"}`,
  );

  const server = createClinicMcpServer();
  await server.connect(new StdioServerTransport());
  console.error(`[${SERVER_NAME}] v${SERVER_VERSION} готов, транспорт stdio`);
}

main().catch((error) => {
  console.error(`[${SERVER_NAME}] Фатальная ошибка:`, error);
  process.exit(1);
});
