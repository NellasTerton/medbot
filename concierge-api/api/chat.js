import Anthropic from "@anthropic-ai/sdk";
import { neon } from "@neondatabase/serverless";
import { createHash } from "node:crypto";
import {
  buildLexicalPatterns,
  expandSearchQuery,
  getDatabaseUrl,
  hasDatabaseUrl,
  missingLeadFields,
  normalizeLead,
  RAG_MATCH_COUNT,
  RAG_MATCH_THRESHOLD,
  requireEnv,
  searchKnowledgeBase,
  submitLead,
} from "../lib/clinic-core.js";

// Поиск по базе знаний и отправка лида вынесены в ../lib/clinic-core.js: тот же
// модуль использует MCP-сервер из mcp-server/. Здесь остаётся логика самого
// HTTP-эндпоинта — маршрутизация интента, диалог с Claude и состояние сессии.
export {
  buildLexicalPatterns,
  expandSearchQuery,
  RAG_MATCH_COUNT,
  RAG_MATCH_THRESHOLD,
};

const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const MAX_MESSAGE_LENGTH = 4000;
const BOOKING_SESSION_TTL_MINUTES = 30;
let bookingSessionsTableReady;

function sendJson(res, status, payload) {
  res.status(status).json(payload);
}

function getAnthropic() {
  return new Anthropic({
    apiKey: requireEnv("ANTHROPIC_API_KEY"),
  });
}

function getAnthropicModel() {
  return process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
}

async function claudeText(system, user, { maxTokens = 500, temperature = 0 } = {}) {
  const anthropic = getAnthropic();
  const message = await anthropic.messages.create({
    model: getAnthropicModel(),
    max_tokens: maxTokens,
    temperature,
    system,
    messages: [{ role: "user", content: user }],
  });

  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();

  if (!text) {
    throw new Error("Anthropic returned an empty response");
  }

  return text;
}

function countDigits(text) {
  return (text.match(/\d/g) || []).length;
}

export function looksLikeContactData(message) {
  const digitCount = countDigits(message);
  return (
    digitCount >= 6 ||
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(message)
  );
}

export function asksClinicInfo(message) {
  return /(?:стоимость|сколько|цена|цену|цены|прайс|стоит|услуг|услуги|услуга|врач|врачи|доктор|специалист|специалисты|расписание|график|прием|приём|адрес|где|находитесь|добраться|телефон|номер|контакт|email|e-mail|почт[а-яё]*|работаете|часы|время работы|суббот|воскрес|узи|ультра[а-яё]*|щитовид|массаж|эндокринолог|невролог|педиатр|подолог|вакцин[а-яё]*|холтер|монитор[а-яё]*|давлен[а-яё]*|беремен[а-яё]*|гигиен[а-яё]*|зуб[а-яё]*|справк[а-яё]*)/i.test(
    message,
  );
}

export function directlyRequestsBooking(message) {
  return /(?:записать|записаться|запишите|заявк[а-яё]*|оставить заявку|хочу на прием|хочу на приём|оформить запись|(?:хочу|нужна|нужен|нужны)\s+(?:консультац[а-яё]*|прием|приём|процедур[а-яё]*)|(?:хочу|надо|нужно)\s+(?:на|к)\s+(?:узи|ультра[а-яё]*|массаж|подолог[ау]?|невролог[ау]?|гинеколог[ау]?|эндокринолог[ау]?|педиатр[ау]?|терапевт[ау]?|семейн[а-яё]*\s+врач[ау]?|врач[ау]?|доктор[ау]?|гигиен[а-яё]*|вакцин[а-яё]*|холтер))/i.test(
    message,
  );
}

function cancelsBooking(message) {
  return /(?:отмена|отменить|не хочу записываться|передумал|передумала)/i.test(
    message,
  );
}

async function classifyIntent(message) {
  if (looksLikeContactData(message)) {
    return "BOOKING";
  }

  if (asksClinicInfo(message) && !directlyRequestsBooking(message)) {
    return "QUESTION";
  }

  if (directlyRequestsBooking(message)) {
    return "BOOKING";
  }

  const answer = await claudeText(
    "Ты маршрутизатор. Если пользователь спрашивает про стоимость, услуги, врачей или расписание (даже если использует слово 'прием') — верни строго QUESTION. Верни BOOKING только если пользователь ПРЯМО просит записать его, оставить заявку или уже пишет свои контактные данные. Верни только одно слово.",
    message,
    { maxTokens: 10, temperature: 0 },
  );

  return answer.toUpperCase().includes("BOOKING") ? "BOOKING" : "QUESTION";
}

async function answerQuestion(message) {
  const documents = await searchKnowledgeBase(message);

  if (documents.length === 0) {
    return {
      intent: "QUESTION",
      reply:
        "В базе клиники не нашлось достаточно точной информации по этому вопросу. Уточните формулировку или оставьте заявку, администратор поможет.",
      sources: [],
    };
  }

  const context = documents
    .map((doc, index) => `[${index + 1}] ${doc.content}`)
    .join("\n\n");

  const rawReply = await claudeText(
    "Ответь пользователю строго по контексту и без галлюцинаций. Отвечай на том же языке, на котором задан вопрос; если вопрос на русском, отвечай по-русски, даже если контекст на латышском. Отвечай прямо, кратко и обычным текстом без Markdown, звёздочек и заголовков. Не складывай отдельные цены и не рассчитывай итог, если пользователь прямо не просил об этом. Если ответа в контексте нет, честно скажи, что данных недостаточно.",
    `Язык ответа: ${detectAnswerLanguage(message)}\n\nВопрос пользователя:\n${message}\n\nКонтекст из базы знаний:\n${context}`,
    { maxTokens: 500, temperature: 0.1 },
  );
  const reply = cleanAssistantReply(rawReply);

  return {
    intent: "QUESTION",
    reply,
    sources: documents.map((doc) => ({
      id: doc.id,
      similarity: doc.similarity,
    })),
  };
}

function getBookingSessionId(req) {
  const explicitId =
    typeof req.headers?.["x-concierge-session-id"] === "string"
      ? req.headers["x-concierge-session-id"].trim()
      : "";
  const forwardedFor = String(
    req.headers?.["x-forwarded-for"] || req.socket?.remoteAddress || "unknown",
  )
    .split(",")[0]
    .trim();
  const userAgent = String(req.headers?.["user-agent"] || "unknown");

  return createHash("sha256")
    .update(explicitId || `${forwardedFor}|${userAgent}`)
    .digest("hex");
}

async function ensureBookingSessionsTable(sql) {
  if (!bookingSessionsTableReady) {
    bookingSessionsTableReady = sql`
      CREATE TABLE IF NOT EXISTS booking_sessions (
        session_id text PRIMARY KEY,
        name text NOT NULL DEFAULT '',
        phone text NOT NULL DEFAULT '',
        service text NOT NULL DEFAULT '',
        requested_date text NOT NULL DEFAULT '',
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `.catch((error) => {
      bookingSessionsTableReady = undefined;
      throw error;
    });
  }
  await bookingSessionsTableReady;
}

async function loadBookingSession(sql, sessionId) {
  await ensureBookingSessionsTable(sql);
  const rows = await sql`
    SELECT name, phone, service, requested_date AS date
    FROM booking_sessions
    WHERE session_id = ${sessionId}
      AND updated_at > now() - (${BOOKING_SESSION_TTL_MINUTES} * interval '1 minute')
    LIMIT 1
  `;
  return normalizeLead(rows[0]);
}

async function saveBookingSession(sql, sessionId, booking) {
  const lead = normalizeLead(booking);
  await ensureBookingSessionsTable(sql);
  await sql`
    INSERT INTO booking_sessions (
      session_id,
      name,
      phone,
      service,
      requested_date,
      updated_at
    )
    VALUES (
      ${sessionId},
      ${lead.name},
      ${lead.phone},
      ${lead.service},
      ${lead.date},
      now()
    )
    ON CONFLICT (session_id) DO UPDATE SET
      name = EXCLUDED.name,
      phone = EXCLUDED.phone,
      service = EXCLUDED.service,
      requested_date = EXCLUDED.requested_date,
      updated_at = now()
  `;
}

async function clearBookingSession(sql, sessionId) {
  await ensureBookingSessionsTable(sql);
  await sql`
    DELETE FROM booking_sessions
    WHERE session_id = ${sessionId}
  `;
}

function mergeLead(current, next) {
  const normalizedCurrent = normalizeLead(current);
  const normalizedNext = normalizeLead(next);
  return Object.fromEntries(
    Object.keys(normalizedCurrent).map((key) => [
      key,
      normalizedNext[key] || normalizedCurrent[key],
    ]),
  );
}

function missingLeadReply(lead) {
  const labels = {
    name: "имя",
    phone: "телефон",
    service: "услугу",
    date: "желаемые дату или время",
  };
  const missing = missingLeadFields(lead).map((key) => labels[key]);

  return `Уточните, пожалуйста: ${missing.join(", ")}.`;
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    const fencedJson = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedJson) {
      try {
        const parsed = JSON.parse(fencedJson[1].trim());
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed
          : null;
      } catch {
        // Fall through to extracting the widest JSON-looking object below.
      }
    }

    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        const parsed = JSON.parse(text.slice(start, end + 1));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed
          : null;
      } catch {
        return null;
      }
    }

    return null;
  }
}

export function detectAnswerLanguage(message) {
  if (/[А-Яа-яЁё]/.test(message)) {
    return "русский";
  }
  if (/[ĀāČčĒēĢģĪīĶķĻļŅņŠšŪūŽž]/.test(message)) {
    return "латышский";
  }
  return "язык вопроса пользователя";
}

export function cleanAssistantReply(text) {
  return text
    .replace(/^[ \t]{0,3}#{1,6}[ \t]*/gm, "")
    .replace(/\*/g, "")
    .trim();
}

async function collectBooking(message, previousBooking) {
  const current = normalizeLead(previousBooking);
  const raw = await claudeText(
    `Ты менеджер по сбору контактов. Тебе категорически запрещено отвечать на вопросы о ценах, услугах или правилах клиники.
Извлеки только явно указанные пользователем данные и сохрани уже собранные значения. Не придумывай информацию.
Всегда верни только валидный JSON без Markdown и пояснений:
{"name":"","phone":"","service":"","date":""}
Пустая строка означает, что поле ещё не известно.`,
    `Уже собранные данные: ${JSON.stringify(current)}\nНовое сообщение пользователя: ${message}`,
    { maxTokens: 500, temperature: 0 },
  );

  const parsed = parseJsonObject(raw);
  if (!parsed) {
    return {
      intent: "BOOKING",
      status: "collecting",
      reply: missingLeadReply(current),
      booking: current,
    };
  }

  const lead = mergeLead(current, parsed);
  const complete = Object.values(lead).every(Boolean);

  if (!complete) {
    return {
      intent: "BOOKING",
      status: "collecting",
      reply: missingLeadReply(lead),
      booking: lead,
    };
  }

  await submitLead(lead);

  return {
    intent: "BOOKING",
    status: "submitted",
    reply: "Заявка отправлена, администратор скоро свяжется с вами",
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Concierge-Session-Id",
  );

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  const message =
    typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message) {
    return sendJson(res, 400, { error: 'Field "message" is required' });
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return sendJson(res, 400, {
      error: `Message is too long; maximum is ${MAX_MESSAGE_LENGTH} characters`,
    });
  }

  try {
    const sql = hasDatabaseUrl() ? neon(getDatabaseUrl()) : null;
    const sessionId = getBookingSessionId(req);
    const requestBooking = normalizeLead(req.body?.booking);
    const hasRequestBooking = Object.values(requestBooking).some(Boolean);
    const storedBooking =
      !hasRequestBooking && sql
        ? await loadBookingSession(sql, sessionId)
        : normalizeLead();
    const bookingDraft = hasRequestBooking ? requestBooking : storedBooking;
    const hasBookingDraft = Object.values(bookingDraft).some(Boolean);

    if (cancelsBooking(message)) {
      if (sql) {
        await clearBookingSession(sql, sessionId);
      }
      return sendJson(res, 200, {
        intent: "BOOKING",
        status: "cancelled",
        reply: "Хорошо, запись отменена.",
      });
    }

    const asksQuestionDuringBooking =
      hasBookingDraft &&
      asksClinicInfo(message) &&
      !looksLikeContactData(message) &&
      !directlyRequestsBooking(message);
    const intent =
      hasBookingDraft && !asksQuestionDuringBooking
        ? "BOOKING"
        : await classifyIntent(message);
    const result =
      intent === "BOOKING"
        ? await collectBooking(message, bookingDraft)
        : await answerQuestion(message);

    if (sql && result.intent === "BOOKING") {
      if (result.status === "submitted") {
        await clearBookingSession(sql, sessionId);
      } else if (result.status === "collecting") {
        await saveBookingSession(sql, sessionId, result.booking);
      }
    }

    return sendJson(res, 200, result);
  } catch (error) {
    console.error(error);
    return sendJson(res, 502, {
      error: "Не удалось обработать запрос. Попробуйте еще раз позже.",
    });
  }
}
