import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

// Claude Desktop запускает сервер с минимальным окружением, поэтому ключи
// читаем из того же .env, что и concierge-api. src/ и dist/ лежат на одном
// уровне, поэтому относительный путь одинаков для исходников и для сборки.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const CONCIERGE_DIR = path.resolve(moduleDir, "..", "..", "concierge-api");

export const REQUIRED_ENV = [
  "NEON_DATABASE_URL",
  "VOYAGE_API_KEY",
  "MAKE_WEBHOOK_URL",
] as const;

function envCandidates(): string[] {
  const override = process.env.MEDBOT_ENV_FILE?.trim();
  if (override) {
    return [path.resolve(override)];
  }

  return [
    path.join(CONCIERGE_DIR, ".env.local"),
    path.join(CONCIERGE_DIR, ".env"),
  ];
}

/**
 * Загружает переменные из .env концьерж-API. Уже выставленные переменные
 * окружения имеют приоритет: их можно задать прямо в claude_desktop_config.json.
 * Возвращает список файлов, которые реально прочитаны.
 */
export function loadClinicEnv(): string[] {
  const loaded: string[] = [];

  for (const candidate of envCandidates()) {
    if (!existsSync(candidate)) {
      continue;
    }
    const result = loadDotenv({ path: candidate, override: false, quiet: true });
    if (result.error) {
      throw new Error(`Не удалось прочитать ${candidate}: ${result.error.message}`);
    }
    loaded.push(candidate);
  }

  return loaded;
}

/** Переменные из REQUIRED_ENV, которых не хватает после загрузки .env. */
export function missingEnv(): string[] {
  return REQUIRED_ENV.filter((name) => {
    if (name === "NEON_DATABASE_URL") {
      return !process.env.NEON_DATABASE_URL && !process.env.NEON_URI;
    }
    return !process.env[name];
  });
}
