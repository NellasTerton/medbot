// Определения MCP-тулов клиники. Транспорт здесь не выбирается: этот же
// набор поднимают оба входа —
//   mcp-server/src/index.ts  (stdio, локальный запуск из Claude Desktop)
//   concierge-api/api/mcp.js (Streamable HTTP, деплой на Vercel)
// Вся предметная логика берётся из clinic-core.js, того же, что использует
// api/chat.js.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  RAG_MATCH_COUNT,
  missingLeadFields,
  normalizeLead,
  searchKnowledgeBase,
  submitLead,
} from "./clinic-core.js";

export const SERVER_NAME = "clinic-concierge";
export const SERVER_VERSION = "1.0.0";
const MAX_QUERY_LENGTH = 4000;

const INSTRUCTIONS =
  "Инструменты клиники Alma. search_knowledge_base — единственный источник фактов " +
  "об услугах, ценах, врачах, расписании и контактах: отвечай строго по найденным " +
  "документам и не додумывай. submit_booking отправляет заявку администратору, " +
  "поэтому вызывай его только когда пользователь явно просит записать его и известны " +
  "все четыре поля: имя, телефон, услуга и желаемые дата/время.";

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function toolError(text) {
  return { isError: true, content: [{ type: "text", text }] };
}

/** Собирает MCP-сервер с двумя тулами. Транспорт подключает вызывающий код. */
export function createClinicMcpServer() {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "search_knowledge_base",
    {
      title: "Поиск по базе знаний клиники",
      description:
        "Ищет релевантные документы в базе знаний клиники (Neon pgvector + Voyage AI): " +
        "услуги, цены, врачи, расписание, контакты. Принимает вопрос на естественном " +
        "языке — русском или латышском. Возвращает фрагменты документов с оценкой " +
        "релевантности; отвечать пользователю нужно только по ним.",
      inputSchema: {
        query: z
          .string()
          .min(1, "Запрос не может быть пустым")
          .max(MAX_QUERY_LENGTH)
          .describe("Вопрос пользователя, например: сколько стоит приём семейного врача"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe(`Сколько документов вернуть, по умолчанию ${RAG_MATCH_COUNT}`),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ query, limit }) => {
      try {
        const documents = await searchKnowledgeBase(query, { limit });

        if (documents.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `По запросу "${query}" в базе знаний клиники ничего не найдено. Переформулируйте вопрос или предложите оставить заявку администратору.`,
              },
            ],
          };
        }

        const formatted = documents
          .map(
            (doc, index) =>
              `[${index + 1}] id=${doc.id} similarity=${doc.similarity.toFixed(3)}\n${doc.content}`,
          )
          .join("\n\n---\n\n");

        return {
          content: [
            {
              type: "text",
              text: `Найдено документов: ${documents.length}\n\n${formatted}`,
            },
          ],
        };
      } catch (error) {
        return toolError(`Поиск по базе знаний не удался: ${errorMessage(error)}`);
      }
    },
  );

  server.registerTool(
    "submit_booking",
    {
      title: "Отправить заявку на запись",
      description:
        "Отправляет заявку на приём администратору клиники через webhook Make.com. " +
        "Требуются все четыре поля. Вызывать только после явного подтверждения " +
        "пользователя: заявка уходит реальным людям и её нельзя отозвать.",
      inputSchema: {
        name: z.string().min(1).describe("Имя пациента"),
        phone: z.string().min(1).describe("Контактный телефон"),
        service: z
          .string()
          .min(1)
          .describe("Услуга или специалист, например: УЗИ щитовидной железы"),
        date: z
          .string()
          .min(1)
          .describe("Желаемые дата и время в формулировке пациента, например: завтра в 15:00"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const lead = normalizeLead(input);
      const missing = missingLeadFields(lead);

      if (missing.length > 0) {
        return toolError(
          `Заявка не отправлена: не заполнены поля ${missing.join(", ")}. Уточните их у пациента и вызовите инструмент снова.`,
        );
      }

      try {
        await submitLead(lead);
      } catch (error) {
        return toolError(`Не удалось отправить заявку: ${errorMessage(error)}`);
      }

      return {
        content: [
          {
            type: "text",
            text:
              `Заявка отправлена администратору клиники.\n` +
              `Имя: ${lead.name}\nТелефон: ${lead.phone}\nУслуга: ${lead.service}\nДата и время: ${lead.date}`,
          },
        ],
      };
    },
  );

  return server;
}
