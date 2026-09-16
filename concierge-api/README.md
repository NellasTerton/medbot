# API ИИ-консьержа клиники

Vercel Serverless API для маршрутизации чата: вопросы по клинике идут через RAG
в Neon + Voyage AI, готовые заявки уходят в Make.com.

## Локальный запуск

```bash
npm install
copy .env.example .env.local
npx vercel dev
```

Заполните `.env.local`:

- `ANTHROPIC_API_KEY` - ключ Anthropic API;
- `ANTHROPIC_MODEL` - модель Claude, по умолчанию `claude-haiku-4-5-20251001`;
- `VOYAGE_API_KEY` - ключ Voyage AI;
- `NEON_DATABASE_URL` - строка подключения Neon;
- `MAKE_WEBHOOK_URL` - URL Custom Webhook из Make.com.

Запрос:

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"Сколько стоит консультация?\"}"
```

Состояние многошаговой записи хранится в Neon 30 минут. Поэтому клиент может
продолжать отправлять только поле `message`. Для надёжного разделения диалогов
клиенту рекомендуется один раз создать случайный идентификатор и передавать его
во всех запросах в заголовке `X-Concierge-Session-Id`.

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -H "X-Concierge-Session-Id: browser-generated-id" \
  -d "{\"message\":\"Телефон +7 999 123-45-67\"}"
```

Если заголовка нет, backend использует хеш IP-адреса и User-Agent. Старый
вариант с объектом `booking` в теле запроса также поддерживается.

## MCP-эндпоинт /api/mcp

`api/mcp.js` — тот же набор тулов (`search_knowledge_base`, `submit_booking`),
но по транспорту Streamable HTTP. Разворачивается вместе с этим проектом и
использует его переменные окружения, поэтому удалённому MCP-клиенту ничего
настраивать локально не нужно:

```
https://<project>.vercel.app/api/mcp
```

Функция stateless: на каждый POST поднимается свой экземпляр сервера. GET и
DELETE отклоняются с 405, это нормально для serverless.

Эндпоинт публичный. Чтобы закрыть его, добавьте в переменные окружения проекта
`MCP_AUTH_TOKEN` — тогда запросы принимаются только с заголовком
`Authorization: Bearer <token>` или с `?token=<token>` в URL.

## Общий модуль lib/clinic-core.js

Эмбеддинг запроса (Voyage AI), поиск по базе знаний в Neon и отправка лида в
Make.com вынесены в `lib/clinic-core.js`. В `api/chat.js` осталась только
специфика чат-эндпоинта: классификация интента, диалог с Claude и состояние
многошаговой записи.

Описание MCP-тулов лежит в `lib/mcp-tools.js` и тоже не дублируется — его
поднимают оба транспорта:

```
lib/clinic-core.js          общая логика (Voyage + Neon + Make)
├── api/chat.js             HTTP-чат для demo-страницы
└── lib/mcp-tools.js        описание тулов MCP
    ├── api/mcp.js          Streamable HTTP, деплой на Vercel
    └── ../mcp-server/      stdio, локальный запуск из Claude Desktop
```

Модуль лежит внутри `concierge-api/`, чтобы Vercel по-прежнему собирал функцию
из корня проекта без дополнительной настройки.

## Деплой в Vercel

1. Выполните `npm install`.
2. Выполните `npx vercel` и привяжите папку к новому проекту.
3. В Vercel -> Project -> Settings -> Environment Variables добавьте переменные
   из `.env.example` для Production, Preview и Development.
4. Выполните `npx vercel --prod`.
5. Клиент обращается к `https://<project>.vercel.app/api/chat`.

Не добавляйте `.env.local` и файл с ключами в Git.

Для более сильной модели можно поставить `ANTHROPIC_MODEL=claude-sonnet-4-6`.
