# MCP-сервер клиники (stdio)

Локальный вход: Claude Desktop запускает его как дочерний процесс и общается
через stdin/stdout. Ключи при этом нужны на машине пользователя.

Если ключей локально нет, используйте удалённый вариант — те же тулы по
транспорту Streamable HTTP развёрнуты вместе с concierge-api на Vercel и берут
переменные окружения из настроек проекта: см.
[`../concierge-api/README.md`](../concierge-api/README.md), эндпоинт `/api/mcp`.

Описание тулов общее для обоих транспортов и лежит в
[`../concierge-api/lib/mcp-tools.js`](../concierge-api/lib/mcp-tools.js).

Отдаёт две операции консьержа как обычные MCP-инструменты, чтобы их можно было
вызывать из Claude Desktop или Claude Code, а не только через `POST /api/chat`:

| Инструмент | Аргументы | Что делает |
| --- | --- | --- |
| `search_knowledge_base` | `query` (обязательный), `limit` (1–20, по умолчанию 5) | Эмбеддинг запроса через Voyage AI, векторный поиск `match_documents` в Neon плюс lexical fallback по `knowledge_base`. Возвращает фрагменты документов с `similarity`. |
| `submit_booking` | `name`, `phone`, `service`, `date` — все обязательные | Нормализует заявку, проверяет комплектность и отправляет её в Make.com webhook. |

Транспорт — stdio, поэтому сервер запускается самим Claude Desktop как дочерний
процесс. Весь лог идёт в stderr: stdout занят JSON-RPC.

## Общий код с concierge-api

Логика не продублирована. Эмбеддинг, SQL-поиск и отправка лида лежат в
[`../concierge-api/lib/clinic-core.js`](../concierge-api/lib/clinic-core.js), и
этот модуль импортируют оба интерфейса:

```
concierge-api/lib/clinic-core.js
├── concierge-api/api/chat.js   (Vercel serverless, интент + диалог с Claude)
└── mcp-server/src/index.ts     (MCP stdio, тонкая обёртка над теми же функциями)
```

Разница только в том, кто формулирует ответ: `api/chat.js` сам зовёт Anthropic
API, а MCP-сервер отдаёт найденные документы наружу — формулирует уже Claude
Desktop. Поэтому `ANTHROPIC_API_KEY` этому серверу не нужен.

Из-за общего модуля зависимости нужны в обеих папках: `clinic-core.js`
резолвит `@neondatabase/serverless` из `concierge-api/node_modules`.

## Установка

```bash
cd mcp-server
npm run setup
```

`npm run setup` ставит зависимости в `../concierge-api` и в `mcp-server`, затем
собирает TypeScript в `dist/`. Если ставите вручную:

```bash
npm install --prefix ../concierge-api
npm install
npm run build
```

## Переменные окружения

Сервер читает тот же `.env`, что и concierge-api, в таком порядке:

1. `concierge-api/.env.local`
2. `concierge-api/.env`

Уже выставленные переменные процесса имеют приоритет — их можно задать в блоке
`env` в `claude_desktop_config.json`. Путь к файлу переопределяется переменной
`MEDBOT_ENV_FILE`.

Нужны три ключа (см. `../concierge-api/.env.example`):

- `NEON_DATABASE_URL` — строка подключения Neon;
- `VOYAGE_API_KEY` — ключ Voyage AI;
- `MAKE_WEBHOOK_URL` — Custom Webhook из Make.com.

Если какой-то не найден, сервер всё равно стартует, но пишет предупреждение в
stderr, а вызов инструмента вернёт понятную ошибку.

## Подключение к Claude Desktop

Конфиг лежит в `%APPDATA%\Claude\claude_desktop_config.json` (Windows) или
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS).
Готовый блок — в [`claude_desktop_config.example.json`](claude_desktop_config.example.json):

```json
{
  "mcpServers": {
    "clinic-concierge": {
      "command": "node",
      "args": ["E:\\medbot\\mcp-server\\dist\\index.js"]
    }
  }
}
```

После правки конфига Claude Desktop нужно полностью перезапустить (выйти из
иконки в трее, не просто закрыть окно).

Если Claude Desktop не находит `node`, укажите полный путь, например
`"command": "C:\\Program Files\\nodejs\\node.exe"`.

Ключи можно передать и прямо в конфиге, минуя `.env`:

```json
{
  "mcpServers": {
    "clinic-concierge": {
      "command": "node",
      "args": ["E:\\medbot\\mcp-server\\dist\\index.js"],
      "env": {
        "NEON_DATABASE_URL": "postgresql://...",
        "VOYAGE_API_KEY": "pa-...",
        "MAKE_WEBHOOK_URL": "https://hook.eu1.make.com/..."
      }
    }
  }
}
```

## Подключение к Claude Code

```bash
claude mcp add clinic-concierge -- node E:\medbot\mcp-server\dist\index.js
```

## Самопроверка одной командой

```bash
npm run check
```

Скрипт поднимает `dist/index.js` по stdio настоящим MCP-клиентом — ровно так,
как это делает Claude Desktop — и проверяет: какие ключи найдены, проходит ли
handshake, зарегистрированы ли оба тула, отвечает ли реальный поиск по Neon и
отклоняется ли неполная заявка. Реальная заявка не отправляется.

```bash
npm run check -- "Какие врачи принимают детей?"   # свой запрос
npm run check -- --booking                        # плюс реальная отправка в Make.com
```

`--booking` создаёт настоящий лид, поэтому запускайте его только с тестовым
вебхуком в `MAKE_WEBHOOK_URL`.

## Ручная проверка

В диалоге Claude Desktop (после перезапуска в панели инструментов должно
появиться два тула от `clinic-concierge`):

1. **Поиск.** «Через инструмент search_knowledge_base найди, сколько стоит приём
   семейного врача, и ответь строго по найденным документам.»
   Ожидаемо: Claude просит разрешение на вызов, показывает фрагменты прайса с
   `similarity` и отвечает по ним.
2. **Заявка.** «Запиши через submit_booking: Анна, +371 29999999, УЗИ щитовидной
   железы, завтра в 15:00.»
   Ожидаемо: подтверждение отправки и новый запуск сценария в Make.com.
   Неполный набор полей вернёт ошибку с перечислением недостающих — например,
   «не заполнены поля date».

Заявка уходит реальным администраторам, поэтому для теста лучше временно
подставить свой тестовый webhook в `MAKE_WEBHOOK_URL`.

Логи сервера: `%APPDATA%\Claude\logs\mcp-server-clinic-concierge.log`.

Проверить сервер без Claude Desktop можно инспектором:

```bash
npm run inspect
```
