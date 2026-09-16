// Общая логика клиники: эмбеддинг запроса, поиск по базе знаний в Neon и
// отправка лида в Make.com. Модуль используют оба интерфейса:
// - Vercel-функция concierge-api/api/chat.js
// - MCP-сервер mcp-server/src/index.ts
// Здесь нет ничего, что зависит от HTTP-запроса или от Anthropic: генерация
// ответа остаётся на стороне вызывающего кода.

import { neon } from "@neondatabase/serverless";

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const VOYAGE_MODEL = "voyage-3";
const VOYAGE_DIMENSIONS = 1024;
const REQUEST_TIMEOUT_MS = 25_000;

export const RAG_MATCH_THRESHOLD = 0.25;
export const RAG_MATCH_COUNT = 5;

const LEXICAL_STOP_WORDS = new Set([
  "вас",
  "вам",
  "ваш",
  "ваша",
  "ваши",
  "где",
  "есть",
  "какой",
  "какая",
  "какие",
  "можно",
  "нужно",
  "сколько",
  "этот",
  "этого",
]);

export function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

export function getDatabaseUrl() {
  const databaseUrl = process.env.NEON_DATABASE_URL || process.env.NEON_URI;
  if (!databaseUrl) {
    throw new Error("Missing environment variable: NEON_DATABASE_URL");
  }
  return databaseUrl;
}

export function hasDatabaseUrl() {
  return Boolean(process.env.NEON_DATABASE_URL || process.env.NEON_URI);
}

export async function fetchJson(url, options, label) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} returned a non-JSON response`);
  }

  if (!response.ok) {
    const detail = data?.error?.message || data?.message || `HTTP ${response.status}`;
    throw new Error(`${label} error: ${detail}`);
  }

  return data;
}

export async function embedQuery(message) {
  const data = await fetchJson(
    VOYAGE_URL,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requireEnv("VOYAGE_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: [message],
        model: VOYAGE_MODEL,
        input_type: "query",
        output_dimension: VOYAGE_DIMENSIONS,
      }),
    },
    "Voyage AI",
  );

  const embedding = data?.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length !== VOYAGE_DIMENSIONS) {
    throw new Error("Voyage AI returned an invalid embedding");
  }
  return embedding;
}

export function expandSearchQuery(message) {
  const extras = [];

  if (/(?:стоимость|сколько|цена|цену|цены|прайс|стоит)/i.test(message)) {
    extras.push("прайс ценрадис стоимость цена EUR");
  }

  if (
    /(?:стоимость|сколько|цена|цену|цены|прайс|стоит)/i.test(message) &&
    /(?:прием|приём|визит|консультац)/i.test(message) &&
    /(?:врач|врача|доктор|доктора|семейн)/i.test(message)
  ) {
    extras.push(
      "терапевт визит терапевта семейный врач врач общей практики vispārējās prakses ārsta ģimenes ārsta",
    );
  }

  return [message, ...extras].join(" ");
}

export function buildLexicalPatterns(message) {
  const words =
    message
      .toLowerCase()
      .replaceAll("ё", "е")
      .match(/\p{L}{4,}/gu) || [];

  const patterns = [
    ...new Set(
      words
        .filter((word) => !LEXICAL_STOP_WORDS.has(word))
        .map((word) => (word.length >= 7 ? word.slice(0, 5) : word))
        .map((word) => `%${word}%`),
    ),
  ];
  const boostedPatterns = [];

  if (
    /(?:семейн|гименес|gimenes|ģimenes)/i.test(message) ||
    (
      /(?:стоимость|сколько|цена|цену|цены|прайс|стоит)/i.test(message) &&
      /(?:прием|приём|визит|консультац)/i.test(message) &&
      /(?:врач|врача|доктор|доктора)/i.test(message)
    )
  ) {
    boostedPatterns.push(
      "%терапевт%",
      "%визит к терапевту%",
      "%vispārēj%",
      "%prakses%",
      "%ģimenes%",
    );
  }

  return [...new Set([...boostedPatterns, ...patterns])].slice(0, 12);
}

// Векторный поиск через SQL-функцию match_documents плюс lexical fallback по
// knowledge_base. Возвращает до `limit` документов без дублей.
export async function searchKnowledgeBase(message, options = {}) {
  const limit = options.limit ?? RAG_MATCH_COUNT;
  const threshold = options.threshold ?? RAG_MATCH_THRESHOLD;

  const searchMessage = expandSearchQuery(message);
  const embedding = await embedQuery(searchMessage);
  const vector = `[${embedding.join(",")}]`;
  const sql = neon(getDatabaseUrl());

  const semanticDocuments = await sql`
    SELECT id, content, similarity
    FROM match_documents(
      ${vector}::vector,
      ${threshold},
      ${limit}
    )
  `;
  const lexicalPatterns = buildLexicalPatterns(searchMessage);
  const lexicalDocuments =
    lexicalPatterns.length > 0
      ? await sql`
          SELECT
            id,
            content,
            1 - (embedding <=> ${vector}::vector) AS similarity,
            (
              SELECT count(*)
              FROM unnest(${lexicalPatterns}::text[]) AS search_pattern(pattern)
              WHERE content ILIKE search_pattern.pattern
            ) AS lexical_hits
          FROM knowledge_base
          WHERE content ILIKE ANY(${lexicalPatterns}::text[])
          ORDER BY lexical_hits DESC, embedding <=> ${vector}::vector
          LIMIT ${limit}
        `
      : [];

  const documentsById = new Map();
  for (const document of [...lexicalDocuments, ...semanticDocuments]) {
    const id = String(document.id);
    if (!documentsById.has(id)) {
      documentsById.set(id, document);
    }
  }

  return [...documentsById.values()].slice(0, limit).map((document) => ({
    id: String(document.id),
    content: String(document.content),
    similarity: Number(document.similarity),
  }));
}

export function normalizeLead(input = {}) {
  return {
    name: typeof input?.name === "string" ? input.name.trim() : "",
    phone: typeof input?.phone === "string" ? input.phone.trim() : "",
    service: typeof input?.service === "string" ? input.service.trim() : "",
    date: typeof input?.date === "string" ? input.date.trim() : "",
  };
}

export function missingLeadFields(lead) {
  return Object.entries(normalizeLead(lead))
    .filter(([, value]) => !value)
    .map(([key]) => key);
}

export function isLeadComplete(lead) {
  return missingLeadFields(lead).length === 0;
}

export async function postMakeWebhook(lead) {
  const response = await fetch(requireEnv("MAKE_WEBHOOK_URL"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(lead),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Make webhook error: HTTP ${response.status}`);
  }
}

// Нормализует заявку, проверяет комплектность и отправляет её в Make.com.
// Бросает ошибку, если хотя бы одно поле пустое.
export async function submitLead(input) {
  const lead = normalizeLead(input);
  const missing = missingLeadFields(lead);
  if (missing.length > 0) {
    throw new Error(`Incomplete booking, missing fields: ${missing.join(", ")}`);
  }

  await postMakeWebhook(lead);
  return lead;
}
