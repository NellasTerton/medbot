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
import { clientFingerprint, consumeRateLimit } from "../lib/rate-limit.js";

// Эндпоинт публичный (ссылка лежит в резюме), поэтому ограничиваем частоту по
// IP. Лимиты рассчитаны так, чтобы человек, пробующий демо, их не заметил.
const REQUEST_LIMIT = { limit: 120, windowMinutes: 60 };
const BOOKING_LIMIT = { limit: 5, windowMinutes: 24 * 60 };

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

function isBookingCall(body) {
  return body?.method === "tools/call" && body?.params?.name === "submit_booking";
}

/**
 * Считает обращения по IP. Возвращает описание превышения или null, если
 * запрос можно пропускать.
 */
async function checkLimits(req) {
  const fingerprint = clientFingerprint(req);

  const overall = await consumeRateLimit({
    key: `mcp:req:${fingerprint}`,
    ...REQUEST_LIMIT,
  });
  if (!overall.allowed) {
    return {
      windowMinutes: overall.windowMinutes,
      message:
        `Слишком много обращений: не больше ${overall.limit} в час. ` +
        "Попробуйте позже — это демонстрационный стенд.",
    };
  }

  if (!isBookingCall(req.body)) {
    return null;
  }

  const booking = await consumeRateLimit({
    key: `mcp:booking:${fingerprint}`,
    ...BOOKING_LIMIT,
  });
  if (!booking.allowed) {
    return {
      windowMinutes: booking.windowMinutes,
      message:
        `Достигнут дневной лимит заявок: не больше ${booking.limit} в сутки. ` +
        "Это демонстрационный стенд, заявки уходят живым администраторам.",
    };
  }

  return null;
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

  const limited = await checkLimits(req);
  if (limited) {
    res.setHeader("Retry-After", String(limited.windowMinutes * 60));
    return sendJsonRpcError(res, 429, -32002, limited.message);
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
