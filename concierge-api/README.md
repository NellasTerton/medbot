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

## Деплой в Vercel

1. Выполните `npm install`.
2. Выполните `npx vercel` и привяжите папку к новому проекту.
3. В Vercel -> Project -> Settings -> Environment Variables добавьте переменные
   из `.env.example` для Production, Preview и Development.
4. Выполните `npx vercel --prod`.
5. Клиент обращается к `https://<project>.vercel.app/api/chat`.

Не добавляйте `.env.local` и файл с ключами в Git.

Для более сильной модели можно поставить `ANTHROPIC_MODEL=claude-sonnet-4-6`.
