// Счётчик обращений в Neon: публичный MCP-эндпоинт открыт всем, поэтому
// ограничиваем частоту по IP, чтобы никто не сжёг квоту Make.com и Voyage.
//
// Принцип fail-open: если проверка по любой причине не сработала (нет базы,
// таймаут, блокировка), запрос пропускается. Демо, доступное по ссылке из
// резюме, не должно падать из-за собственной защиты.

import { neon } from "@neondatabase/serverless";
import { createHash } from "node:crypto";

import { getDatabaseUrl, hasDatabaseUrl } from "./clinic-core.js";

let rateLimitTableReady;

async function ensureRateLimitTable(sql) {
  if (!rateLimitTableReady) {
    rateLimitTableReady = sql`
      CREATE TABLE IF NOT EXISTS mcp_rate_limit (
        bucket text PRIMARY KEY,
        hits integer NOT NULL DEFAULT 0,
        window_start timestamptz NOT NULL DEFAULT now()
      )
    `.catch((error) => {
      rateLimitTableReady = undefined;
      throw error;
    });
  }
  await rateLimitTableReady;
}

/** Хеш IP-адреса: сам адрес в базе не храним. */
export function clientFingerprint(req) {
  const forwardedFor = String(
    req.headers?.["x-forwarded-for"] || req.socket?.remoteAddress || "unknown",
  )
    .split(",")[0]
    .trim();

  return createHash("sha256").update(forwardedFor).digest("hex").slice(0, 32);
}

/**
 * Регистрирует обращение и говорит, не превышен ли лимит.
 * Возвращает { allowed, hits, limit, windowMinutes }.
 */
export async function consumeRateLimit({ key, limit, windowMinutes }) {
  if (!hasDatabaseUrl()) {
    return { allowed: true, hits: 0, limit, windowMinutes };
  }

  try {
    const sql = neon(getDatabaseUrl());
    await ensureRateLimitTable(sql);

    // Окно скользит целиком: при истечении счётчик сбрасывается в 1.
    const rows = await sql`
      INSERT INTO mcp_rate_limit (bucket, hits, window_start)
      VALUES (${key}, 1, now())
      ON CONFLICT (bucket) DO UPDATE SET
        hits = CASE
          WHEN mcp_rate_limit.window_start < now() - (${windowMinutes} * interval '1 minute')
          THEN 1
          ELSE mcp_rate_limit.hits + 1
        END,
        window_start = CASE
          WHEN mcp_rate_limit.window_start < now() - (${windowMinutes} * interval '1 minute')
          THEN now()
          ELSE mcp_rate_limit.window_start
        END
      RETURNING hits
    `;

    const hits = Number(rows[0]?.hits ?? 0);
    return { allowed: hits <= limit, hits, limit, windowMinutes };
  } catch (error) {
    console.error("rate limit check failed, allowing request", error);
    return { allowed: true, hits: 0, limit, windowMinutes };
  }
}
