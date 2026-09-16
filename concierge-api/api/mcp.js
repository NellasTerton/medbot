// Удалённый MCP-сервер клиники: транспорт Streamable HTTP поверх той же
// логики, что и api/chat.js. Разворачивается вместе с этим Vercel-проектом,
// поэтому переменные окружения (NEON_DATABASE_URL, VOYAGE_API_KEY,
// MAKE_WEBHOOK_URL) берутся из настроек проекта — ничего настраивать локально
// не нужно.
//
// Serverless-функция не хранит состояние между вызовами, поэтому транспорт
// работает в stateless-режиме: на каждый запрос поднимается свой экземпляр
// сервера, который закрывается вместе с ответом.

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createClinicMcpServer } from "../lib/mcp-tools.js";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "1mb",
    },
  },
};

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

// Токен опционален: если MCP_AUTH_TOKEN задан в переменных окружения проекта,
// без него эндпоинт не отвечает. Принимаем и заголовок, и query-параметр —
// не все MCP-клиенты умеют добавлять кастомные заголовки.
function isAuthorized(req) {
  const expected = process.env.MCP_AUTH_TOKEN;
  if (!expected) {
    return true;
  }

  const header = String(req.headers?.authorization || "");
  if (header.startsWith("Bearer ") && header.slice(7).trim() === expected) {
    return true;
  }

  const url = new URL(req.url || "/", "http://localhost");
  return url.searchParams.get("token") === expected;
}

function sendJsonRpcError(res, status, code, message) {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (!isAuthorized(req)) {
    return sendJsonRpcError(res, 401, -32001, "Unauthorized");
  }

  // В stateless-режиме поток сервер -> клиент не поддерживается,
  // поэтому GET (SSE) и DELETE (закрытие сессии) отклоняем явно.
  if (req.method !== "POST") {
    return sendJsonRpcError(
      res,
      405,
      -32000,
      "Method not allowed: this MCP endpoint is stateless and accepts POST only",
    );
  }

  const server = createClinicMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      sendJsonRpcError(res, 500, -32603, "Internal server error");
    }
  }
}
