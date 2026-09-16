#!/usr/bin/env node
// Самопроверка MCP-сервера: поднимает dist/index.js как дочерний процесс по
// stdio настоящим MCP-клиентом и вызывает тулы ровно так же, как это сделает
// Claude Desktop.
//
//   npm run check                     — окружение, список тулов, реальный поиск
//   npm run check -- --booking        — плюс отправка тестовой заявки в Make.com
//   npm run check -- "свой запрос"    — свой вопрос вместо примера по умолчанию

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { loadClinicEnv, missingEnv, CONCIERGE_DIR } from "../dist/env.js";

const args = process.argv.slice(2);
const sendBooking = args.includes("--booking");
const query =
  args.find((arg) => !arg.startsWith("--")) ??
  "Сколько стоит приём семейного врача?";

const serverEntry = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "index.js",
);

function mask(value) {
  if (!value) return "не задано";
  return value.length <= 12
    ? "задано"
    : `${value.slice(0, 6)}…${value.slice(-4)} (${value.length} симв.)`;
}

function firstText(result) {
  return result.content?.find((part) => part.type === "text")?.text ?? "";
}

let failed = false;
function report(ok, title, detail) {
  if (!ok) failed = true;
  console.log(`${ok ? "OK  " : "FAIL"} ${title}${detail ? `\n     ${detail}` : ""}`);
}

console.log("== 1. Окружение ==");
const envFiles = loadClinicEnv();
console.log(
  `.env: ${envFiles.length > 0 ? envFiles.join(", ") : `не найден в ${CONCIERGE_DIR}`}`,
);
console.log(`NEON_DATABASE_URL: ${mask(process.env.NEON_DATABASE_URL || process.env.NEON_URI)}`);
console.log(`VOYAGE_API_KEY:    ${mask(process.env.VOYAGE_API_KEY)}`);
console.log(`MAKE_WEBHOOK_URL:  ${mask(process.env.MAKE_WEBHOOK_URL)}`);

const missing = missingEnv();
report(
  missing.length === 0,
  "переменные окружения",
  missing.length > 0
    ? `не хватает: ${missing.join(", ")} — заполните ${path.join(CONCIERGE_DIR, ".env.local")}`
    : "",
);

console.log("\n== 2. Запуск сервера по stdio ==");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: process.env,
  stderr: "pipe",
});
const client = new Client({ name: "clinic-concierge-check", version: "1.0.0" });

try {
  await client.connect(transport);
  transport.stderr?.on("data", (chunk) => process.stderr.write(`     [server] ${chunk}`));
  const info = client.getServerVersion();
  report(true, "handshake", `${info?.name} v${info?.version}`);

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  report(
    names.join(",") === "search_knowledge_base,submit_booking",
    "список тулов",
    names.join(", ") || "тулы не зарегистрированы",
  );

  console.log("\n== 3. search_knowledge_base ==");
  console.log(`запрос: ${query}`);
  const search = await client.callTool({
    name: "search_knowledge_base",
    arguments: { query, limit: 3 },
  });
  const searchText = firstText(search);
  report(!search.isError, "поиск по базе знаний");
  console.log(searchText.slice(0, 900) + (searchText.length > 900 ? "\n     […]" : ""));

  console.log("\n== 4. submit_booking ==");
  const incomplete = await client.callTool({
    name: "submit_booking",
    arguments: { name: "Тест", phone: "+37129999999", service: "УЗИ", date: "  " },
  });
  report(
    incomplete.isError === true && firstText(incomplete).includes("date"),
    "неполная заявка отклоняется",
    firstText(incomplete),
  );

  if (!sendBooking) {
    console.log(
      "     Отправка реальной заявки пропущена. Запустите с --booking, когда\n" +
        "     в MAKE_WEBHOOK_URL стоит тестовый вебхук: заявка уйдёт администраторам.",
    );
  } else {
    const booking = await client.callTool({
      name: "submit_booking",
      arguments: {
        name: "Тестовая заявка (check.mjs)",
        phone: "+371 29999999",
        service: "УЗИ щитовидной железы",
        date: "завтра в 15:00",
      },
    });
    report(!booking.isError, "отправка заявки в Make.com", firstText(booking));
  }
} finally {
  await client.close().catch(() => {});
}

console.log(`\n== Итог: ${failed ? "есть проблемы, см. FAIL выше" : "всё зелёное"} ==`);
process.exit(failed ? 1 : 0);
